# doc-block 插件设计与稳定性重构方案

> 本文档记录：需求由来、当前实现现状与问题、根因分析、重构设计方案、待补齐事项。
> 目的：在继续开发前统一认知，避免"头痛医头脚痛医脚"式打补丁。

---

## 1. 背景与需求演进

### 1.1 原始诉求

SiYuan（思源笔记）没有 Notion 那种"页面即块"的一等概念：文档和块是两套体系，文档只能通过文档树（`.sy` 文件路径嵌套）组织父子关系，块引用（block-ref）只是普通链接，不具备"子页面"语义。

用户希望在 SiYuan 里获得接近 Notion 的体验：

- 把"文档"当作可以像块一样出现在正文里的对象（**文档块**）。
- 文档块与被引用文档建立**唯一双向绑定**：块记录 `docId`，文档反向记录 `blockId`。
- 支持对文档块做 Notion 式的：
  - **新建**：斜杠菜单创建子文档并插入文档块。
  - **删除**：删除文档块 -> 对应文档移入「垃圾箱」笔记本（而不是物理删除）。
  - **移动**：
    - 在文档树里移动文档 -> 对应文档块在正文中随之移动到新父文档末尾。
    - 在正文里移动文档块 -> 对应文档在文档树中随之移动。
  - **排序**：
    - 正文中文档块的前后顺序变化 -> 文档树中子文档顺序同步。
    - 文档树中子文档顺序变化 -> 正文中文档块顺序同步。
  - **复制/粘贴**（Notion 语义）：复制文档块并粘贴 -> 产生一个**全新的、内容复制**的文档，标题为"原名(1)"；多次粘贴仍是"原名(1)"（不是"原名(2)(3)..."，与 Notion 行为对齐）；复制后即使原块被删除，粘贴仍能产生副本。
  - **剪切/粘贴**（Notion 语义）：剪切 -> 原文档移入垃圾箱；粘贴 -> 把**同一个**文档从垃圾箱移出到新位置（不新建文档，标题不变）；如果剪切后又撤销（undo 恢复了原块），则剪切状态失效，后续粘贴应退化为"复制"语义（产生副本）。

### 1.2 关键设计取舍讨论

- 讨论过"是否应该抛弃'块内嵌 docId 属性'的思路，改成外部维护一份 YAML/文档做父子关系视图"。结论是：核心矛盾不是数据结构选型，而是 **SiYuan 的文档模型和块模型是两套独立的树，任何方案都要处理两棵树的双向同步**，外部视图无法规避这个问题，反而会失去 SiYuan 原生的撤销/协作/搜索能力。因此维持"块属性 + 双向指针"的方案，但要控制同步复杂度。
- 讨论过"垃圾箱"命名与自动创建：已实现为固定笔记本名「垃圾箱」，首次需要时自动创建（`ensureTrashNotebook`），支持历史命名迁移（`文档回收`）。
- 讨论过复制粘贴的语义边界：明确"文档块的复制"必须导致**新文档**产生（内容深拷贝），而不是新建一个指向同一 `docId` 的块引用——这是当前最容易做错、也是用户反馈"复制多份却指向同一文档"的核心症结。

---

## 2. 当前实现现状（截至 v1.10.20）

单文件实现：`index.js`，约 **5100 行**，无构建步骤，`plugin.json` 中 `main` 直接指向该文件。所有逻辑（DOM 解析、剪贴板处理、SQL 查询、fetch 拦截、WebSocket 事件处理、reconcile 调度）都堆在一个模块作用域里。

### 2.1 核心持久化模型

- 块属性：`custom-doc-block=1` + `custom-doc-id=<subDocId>`（正向：块 -> 文档）。
- 文档属性：`custom-doc-block-id=<blockId>`（反向：文档 -> 块）。
- 块内容格式：`((docId "title"))` 形式的 block-ref，渲染时带图标前缀。

### 2.2 运行时同步机制（当前非常复杂）

插件同时通过 **四条独立通道** 感知"用户做了什么"，并各自触发处理：

1. **`window.fetch` 猴子补丁**（`patchFetch`）：拦截所有出站 API 请求（`createDoc`、`removeDocByID`、`moveDocsByID`、`renameDocByID`、`/api/transactions` 等），解析请求体推测意图（`prepareApiContext`），在响应返回后调用 `applyApiContext` 触发相应的插件逻辑。
2. **`ws-main` 事件总线**（`handleWsMain`）：监听 SiYuan 内核推送的 WebSocket 消息（`create`/`removeDoc`/`moveDoc`/`rename`/`savedoc`/`transactions` 等），做几乎同一套事情的第二次处理。
3. **`protyle-change` 编辑器事件**：块内容变化时刷新 `blockToSubDoc` 缓存。
4. **`copy`/`cut`/`paste` DOM 事件拦截**：维护一个"文档剪贴板状态机"（`docClipboardState`），并在粘贴时决定是"移动原文档"还是"复制新文档"。

以上 1 和 2 在很多操作下会**对同一个用户动作各自触发一次**（例如一次移动文档，`fetch` 通道和 `ws-main` 通道都会各收到一次事件），因此额外引入了：

- `recentMoveEventKeys` / `recentDocMoveKeys` / `recentSyncKeys` / `recentCreateKeys`：一堆"去重时间窗口"表，靠时间戳 + key 猜测"这是不是同一个事件的重复通知"。
- `enqueueSubDocSync` / `enqueueParentSync`：按 `subDocId` / `parentDocId` 排队保证同一文档的操作串行执行，避免竞态。
- `scheduleParentReconcile` + `reconcileParentBlockOrderFromTree` / `reconcileParentTreeOrderFromBlocks`：定期"和解"文档树顺序与文档块顺序，双向都做，容易产生**回环**（A 通道同步触发 B 通道再同步回 A）。

### 2.3 复制/粘贴现状

- `handleCopyCapture`：只有当选区**严格是单个纯文档块**时才建立 `docClipboardState`（`mode: copy|cut`），否则清空剪贴板状态并退回到"内容级"复制（`buildMixedSelectionClipboard` / `writeDocRefsToClipboardData`）。
- `handlePasteEvent`：优先尝试 `tryHandleDocClipboardPaste`（命中剪贴板状态机则走"新建文档并深拷贝内容"或"移出垃圾箱"逻辑）；**未命中则回退到 `processPasteContent`**，这条回退路径只是把剪贴板里的 HTML/Markdown 转换成 block-ref 文本插入，**不会新建文档**，粘贴出来的块必然指向同一个 `docId`。

现象："复制粘贴多次得到同一文档"，根因就是很多实际操作路径没有命中"剪贴板状态机"分支，而是走了内容转换 fallback。

### 2.4 已加入的调试手段

- `debugReconcile` 配置开关 + `debugReconcileLog`：reconcile 过程打印统计。
- 会话级文件日志（本次新增）：
  - 每次 `onload` 在 `D:\LPX\Desktop\siyuanlog` 下创建一个新的 `sub-doc-block-<时间戳>-<随机>.jsonl` 日志文件，并写 `latest.txt` 指向最新文件。
  - 覆盖：用户复制/剪切/粘贴、fetch 拦截上下文、ws-main/transactions、trash 相关操作、bind/reconcile 全链路、console 镜像。

---

## 3. 已定位的问题证据

从最新一轮测试日志（`sub-doc-block-20260706-155105-jano1c.jsonl`）中复现出的真实链路：

```
07:52:05.985  user.paste.raw
07:52:05.985  user.paste.doc-clipboard.detected (mode=copy)
07:52:05.998  fetch /api/transactions   <- SiYuan 编辑器自身在处理粘贴产生的 DOM 变化事务
07:52:06.000  ws-main: txerr            <- 内核报事务失败（早于插件自己的 createDoc 调用）
07:52:06.001  copy-subdoc.start          <- 插件才开始新建复制文档
07:52:06.003  fetch /api/filetree/createDoc
07:52:06.034  ws-main: savedoc (rootID=新文档)
07:52:06.050  ws-main: transactions（协议插入 <span data-type="block-ref" ...> 未命名阿萨德(1)）
```

**结论**：`txerr` 发生在插件的 `createDoc` 调用之前，说明 SiYuan 编辑器自己针对"粘贴事件默认行为"已经先提交了一次事务（因为 `event.preventDefault()` 在插件异步逻辑跑完之前还没执行/或者浏览器原生粘贴与 `protyle` 内部逻辑存在竞态），这次事务本身结构就有问题（`id:""` 的插入节点），随后才轮到插件的"真正处理"。

也就是说：**当前 `paste` 事件处理是异步的，而 SiYuan 编辑器可能在插件 `await` 期间已经开始处理默认粘贴逻辑**，两边同时改 DOM/发事务，产生冲突事务，触发 `invalid data tree`。这是最优先要修的时序 bug。

---

## 4. 根因总结

不是 SiYuan 提供的单个 API（`createDoc`/`moveDocsByID`/`appendBlock`）不稳定，而是当前实现的**系统性复杂度**超过了可维护、可验证的范围：

1. **多通道重复感知同一事件**（fetch 拦截 + ws-main），靠时间窗口去重，本质是"猜测式去重"，一旦网络延迟/内核批量提交节奏变化就会失准。
2. **粘贴处理是异步的，但没有在拦截时刻同步阻断编辑器默认行为**，导致编辑器默认粘贴事务和插件的自定义粘贴逻辑并发执行，产生冲突事务（`txerr` / `invalid data tree`）。
3. **双向 reconcile（树→块、块→树）没有单一事实来源（source of truth）**，两个方向的 reconcile 都可能被对方触发的事件唤醒，存在潜在回环和顺序抖动。
4. **单文件 5000+ 行、状态分散在几十个 Map/Set 字段里**，没有集中的状态机文档，很难在改动时评估影响面，也是"改一处、坏一处"的直接原因。
5. **复制/粘贴的分支覆盖不全**：只有"选区严格是单个纯文档块"才建立剪贴板状态机，边界条件（多选、混合选择、跨窗口粘贴、粘贴目标不是 protyle）都会静默退化到不做深拷贝的旧逻辑。

---

## 5. 重构设计方案

### 5.1 指导原则

- **先收敛，再扩展**：优先把"单向、可预测、可回滚"的最小闭环做稳，再逐步恢复高级特性（双向排序自动化、reconcile 自愈等）。
- **单一事实来源（SSOT）优先**：明确定义"某一时刻，文档树结构 vs 正文文档块顺序，谁是权威来源"，避免同时双向写。
- **同步优于异步猜测**：能在事件当下同步处理/阻断的，不要用"时间窗口去重"这种概率性手段。
- **状态可观测**：任何自动修复动作之前，先落一条不变量检查日志，方便复盘。

### 5.2 分层重构

```
┌─────────────────────────────────────────┐
│ 输入层：唯一事件入口                       │
│  - 只保留 ws-main（内核权威事件），        │
│    停用/降级 fetch 拦截为“仅日志观察”。    │
│  - 复制/剪切/粘贴：改为在捕获阶段          │
│    同步 preventDefault，不给编辑器         │
│    默认行为执行机会。                      │
├─────────────────────────────────────────┤
│ 意图层：DocBlock 操作语义化                │
│  - create / delete / move / reorder /     │
│    copyPaste / cutPaste 六种意图，         │
│    每种意图只有一个处理函数，              │
│    不允许跨函数互相调度对方。              │
├─────────────────────────────────────────┤
│ 执行层：API 调用 + 校验                    │
│  - 每个 API 调用后，立即做“不变量校验”：   │
│    目标文档存在 / 目标块存在 / 绑定唯一。   │
│  - 校验失败 -> 记录 + 提示，               │
│    不做自动连锁修复（避免越修越乱）。       │
├─────────────────────────────────────────┤
│ 观测层：结构化日志（已完成）                │
│  - 会话级 jsonl 日志 + latest 指针。       │
└─────────────────────────────────────────┘
```

### 5.3 具体修复项（按优先级）

**P0（先止血，解决 `invalid data tree` / 崩溃）**

1. ✅ **已修复（v1.10.21）** 复制/剪切/粘贴事件改为**同步优先处理**。
   - **确证根因**：查阅 SiYuan 官方插件示例（`plugin-sample/src/index.ts`）及社区文档，`paste` 事件的官方约定是——
     > "如果需异步处理请调用 preventDefault，否则会进行默认处理；如果使用了 preventDefault，必须调用 resolve，否则程序会卡死"
     即 `event.preventDefault()` **必须在事件处理函数的同步阶段**（第一个 `await` 之前）调用，SiYuan 在 `emit("paste", ...)` 之后会**同步**检查 `event.defaultPrevented` 来决定是否执行默认粘贴。
   - 旧实现 `async handlePasteEvent` 一路 `await`（`isDocumentPresent` -> `resolvePasteTargetContext` -> ... -> `bindSubDocBlock`）到最后才调用 `event.preventDefault()`，这段时间里 SiYuan 早已按默认粘贴逻辑提交了一次事务；随后插件的异步逻辑又各自创建/绑定了一次块，两次事务互相冲突，这正是日志中 `txerr` 紧跟在 `/api/transactions` 之后、随即 `invalid data tree` 弹窗的直接原因。
   - **修复方式**：`handlePasteEvent` 改为**非 async 的同步函数**，在函数体最开始（无任何 `await`）就用 `getDocClipboardState()`（本身是同步读取内存/`sessionStorage`）判断是否要接管这次粘贴；一旦判定接管，**立刻同步调用 `event.preventDefault()`**，再把真正的异步逻辑转交给新增的 `finishDocClipboardPaste`；无论异步逻辑成功与否，最终都保证调用一次 `detail.resolve(...)`（新增 `resolvePasteWithFallback` 兜底），避免编辑器卡死。
   - 影响面评估：由于"复制/剪切/粘贴导致事务冲突"会污染内核当次事务序列，**很可能也是用户反馈的"排序有时不同步""删除有时不进垃圾箱"这两个问题的部分诱因**（崩溃后续的 ws 事件顺序/内容可能已经不可信）。建议先只验证这一修复本身，再用新日志重新评估排序/删除问题是否还存在、严重程度是否下降。
2. 去掉"以 fetch 拦截驱动业务逻辑"的用法，`patchFetch` 仅保留日志观察功能（已经具备），不再触发 `applyApiContext` 之类的业务副作用；业务副作用**只由 `ws-main`（内核广播）驱动一次**，消除双通道重复触发。*(尚未实施，见下方测试计划——先验证 P0.1 效果，再评估是否需要此项)*
3. ✅ **已修复（v1.10.21）** 去除代码里发现的**重复函数定义**：`writeDocBlockBinding` 此前定义了两次（第 1913 行与第 1958 行，内容完全相同），已删除冗余的第二份定义。

**P1（收敛同步方向，解决排序/移动不同步）**

4. 明确排序同步的 SSOT 规则，例如：
   - 用户在**文档树**里拖动 -> 树是权威 -> 只触发"树→块"reconcile。
   - 用户在**正文**里拖动文档块 -> 正文是权威 -> 只触发"块→树"reconcile。
   - 两个 reconcile 函数互斥执行（同一 `parentDocId` 同一时刻只允许一个方向在跑，已有 `parentSyncChains` 机制，需要补充"方向互斥锁"，而不仅是"同方向排队"）。
5. 复制粘贴分支覆盖率补齐：把"单选文档块"之外的场景（多选纯文档块、拖拽复制等）也纳入统一意图判定，而不是静默退化。

**P2（工程化，降低后续维护成本）**

6. 拆分单文件为模块（即使仍打包成一个 `dist/index.js`，也建议按 `src/` 分文件：`clipboard.js`、`reconcile.js`、`api.js`、`logger.js`、`dom.js` 等），便于单独测试和审查。
7. 为核心不变量补充自检命令（例如设置面板里加一个"检查文档块健康度"按钮：扫描所有 `custom-doc-block=1` 的块，校验双向绑定一致性，列出孤儿块/孤儿文档）。

### 5.4 不做的事情（明确排除，避免范围蔓延）

- 不引入外部 YAML/独立数据库维护父子关系（已讨论过，收益不足以抵消复杂度）。
- 不在本轮重构中扩展新功能（例如多文档块拖拽排序动画、跨笔记本复制等），先把六个基础操作做稳。

---

## 6. 当前缺失 / 待统一设计的点

1. **粘贴同步拦截的具体实现方式**：SiYuan `paste` 事件（`eventBus.on("paste", ...)`）的 `detail.resolve` 是否支持"先同步 preventDefault 再异步 resolve"，需要用最小复现例验证（P0 第 1 项的前置调研）。
2. **"文档树 vs 正文顺序 谁是权威"的用户可见规则**：目前只在代码里隐含规则，需要在设置面板/文档里给用户一句话说明，避免用户两边同时改导致预期落空。
3. **孤儿数据清理策略**：文档被物理删除但块还在、块被删除但文档还在垃圾箱之外的情况，目前靠零散的 `hasOtherSubDocBlocks` / `isCanonicalOwnerBlock` 判断，需要汇总成一个统一的"健康检查"函数（对应 5.3 第 7 项）。
4. **多选/跨文档复制粘贴的语义**：当前只定义了"单个文档块"的复制/剪切语义，多选多个文档块时的 Notion 对齐行为尚未设计（Notion 里多选复制会各自产生"(1)"后缀的独立副本）。
5. **回收站清理策略的边界**：`autoClearTrashOnStartup` 配置项存在，但"垃圾箱里的文档什么时候可以被永久清理、清理前是否需要二次确认"尚未在文档中明确。
6. **测试/回归手段**：目前完全依赖人工在 UI 上操作 + 事后读日志，没有任何自动化回归（哪怕是"重放一组事务, 断言最终不变量成立"的脚本级测试）也应纳入后续计划。

---

## 7. 附：关键文件/函数索引（现状，供后续重构对照）

| 关注点 | 位置（`index.js`） |
| --- | --- |
| 持久化属性常量 | `ATTR_BLOCK` / `ATTR_DOC_ID` / `ATTR_DOC_BLOCK_ID`（文件头部） |
| 剪贴板状态机 | `setDocClipboardState` / `getDocClipboardState` / `clearDocClipboardState` / `buildCopyDocTitle` |
| 复制捕获 | `handleCopyCapture` |
| 粘贴处理 | `handlePasteEvent` -> `tryHandleDocClipboardPaste` -> `createCopiedSubDocForPaste` |
| 粘贴内容转换 fallback（问题路径） | `processPasteContent` |
| fetch 拦截 | `patchFetch` / `prepareApiContext` / `applyApiContext` |
| ws-main 处理 | `handleWsMain` / `handleWsTransactions` |
| 双向 reconcile | `scheduleParentReconcile` / `reconcileParentBlockOrderFromTree` / `reconcileParentTreeOrderFromBlocks` |
| 垃圾箱管理 | `ensureTrashNotebook` / `moveSubDocsToTrash` / `isSubDocInTrash` |
| 绑定写入（存在重复定义，待清理） | `writeDocBlockBinding`（第 1913 行与第 1958 行两处） |
| 会话日志 | `initSessionLogger` / `logEvent` / `installConsoleMirror` |

---

## 8. 修复进度记录（Changelog）

### v1.10.21

- **[P0.1 已修复]** `paste` 事件处理改为同步优先接管，杜绝与 SiYuan 编辑器默认粘贴行为的并发冲突（详见 5.3 节）。这是目前唯一一处有**确凿证据**（官方文档 + 实测日志时间线）支撑的根因修复。
- **[P0.3 已修复]** 清理重复定义的 `writeDocBlockBinding` 函数。
- **未改动**：fetch 拦截驱动业务逻辑（P0.2）、双向 reconcile 互斥锁（P1.4）、复制粘贴分支覆盖率（P1.5）等项**暂不动**，原因：
  1. 这些改动面更大，风险更高，应该在验证 P0.1 效果之后再决定是否需要、需要到什么程度；
  2. 避免一次性改太多导致无法定位"到底是哪个改动解决/引入了问题"。

### v1.10.22 —— 复制粘贴 invalid data tree 的真正根因（有日志实锤）

v1.10.21 修的是"粘贴事件与编辑器默认粘贴的并发冲突"，这个问题确实修好了（日志里不再出现编辑器默认粘贴产生的空 `id:""` 事务）。但用户反馈"只做一次复制粘贴还是报 invalid data tree"，于是这次直接比对 **crash 那一次会话**的完整日志（`sub-doc-block-20260706-162527-1vrw0g.jsonl`），而不是空的最新日志，抓到了确凿的并发证据：

```
25:38.539  copy-subdoc.start        subDocId(old)=...e87z8xt  targetParent=...6yjga3b
25:38.705  bind.schedule  source=ws-create             subDocId(new)=...876pc87
25:38.705  bind.start     source=ws-create             subDocId(new)=...876pc87
25:38.707  copy-subdoc.create-doc-response  code=0  （createDoc 接口才刚返回）
25:38.707  copy-subdoc.done          newSubDocId=...876pc87
25:38.707  bind.start     source=clipboard-copy-paste  subDocId(new)=...876pc87   ← 同一个 subDocId！
25:38.957  bind.append.done source=ws-create            blockId=...r1r4a57
25:39.074  bind.append.done source=clipboard-copy-paste blockId=...5auztvb        ← 又append了一次！
25:39.082  ws-main cmd=txerr
```

**根因**：`createCopiedSubDocForPaste` 内部调用 `/api/filetree/createDoc` 创建副本文档后，SiYuan 内核会通过 WS 广播一条通用的 `create` 事件（内核并不知道这个创建是插件自己发起的）。插件的 `handleWsMain` 收到后，按"用户在文档树/斜杠菜单新建了子文档"的逻辑，通过 `onSubDocCreated -> scheduleBindSubDocBlock -> bindSubDocBlock` 自动补一个文档块。

与此同时，粘贴逻辑（`tryHandleDocClipboardPaste`）在拿到新文档 id 后，**直接**调用了 `this.bindSubDocBlock(...)`，而不是走带互斥锁的 `scheduleBindSubDocBlock`。这条直连路径完全绕过了 `insertingSubDocBlocks` 锁，导致：

- ws-create 广播触发的自动绑定，和
- 粘贴逻辑自己发起的绑定，

两者并发执行，各自都判断"这个 subDocId 还没有文档块"，于是各自 `appendBlock` 了一次，给同一个新文档生成了两个文档块（`r1r4a57` 与 `5auztvb`）。SiYuan 内核在处理这两笔几乎同时提交的事务时数据树出现冲突，报 `txerr` / `invalid data tree`。

这与"移动/删除/顺序不稳定"是**同一类系统性问题**：凡是"同一个 subDocId 的绑定/解绑操作"存在多个入口，只要有一个入口没有走统一的互斥锁，就会在内核 WS 广播和插件自身逻辑之间产生竞态。

**修复（`bindSubDocBlock` 收口为唯一入口）**：

- 新增 `bindSubDocBlockPromises: Map<subDocId, Promise<boolean>>`。
- `bindSubDocBlock(parentDocId, subDocId, ...)` 不再是纯 `async` 函数体本身，而是一个同步的**锁获取器**：
  - 若 `bindSubDocBlockPromises` 里已有该 `subDocId` 的进行中 Promise，直接 `return` 复用它（记一条 `bind.join-inflight` 日志），保证同一个 `subDocId` 永远只会真正执行一次绑定逻辑，无论是谁、通过哪条路径第一个发起的。
  - 否则同步地把 `subDocId` 加入 `insertingSubDocBlocks`（这一步必须在任何 `await` 之前完成，才能保证后来者一定能看到），再调用原来的绑定逻辑（改名为 `_bindSubDocBlockImpl`），并把返回的 Promise 存入 `bindSubDocBlockPromises`，`finally` 里清理两个集合。
- `scheduleBindSubDocBlock`（给 `onSubDocCreated`/reconcile/move 等"被动感知"场景用）不再自己维护 `insertingSubDocBlocks`，只是快速跳过明显已在锁内的调用，真正的互斥完全交给 `bindSubDocBlock`。
- 粘贴逻辑里对 `bindSubDocBlock` 的直接调用**不需要改**，因为锁现在下沉到了函数内部，任何调用方都会自动共享同一把锁。

这样无论 ws-create 广播和粘贴逻辑谁先到，后到的那个都会拿到前一个的 Promise 结果，而不是再发起一次独立的 `appendBlock`，从根本上消除了这一类"同一 subDocId 双重绑定"的竞态。

### v1.10.23 —— 粘贴后仍 txerr：异步 resolve + ws-create 未跳过

v1.10.22 之后日志（`165201-4z8ono`）显示双重绑定已消除（出现 `bind.join-inflight`，只有一次 `bind.append.done`），但 **`txerr` 仍然在 `user.paste.doc-clipboard.done` 之后触发**。

进一步比对事务内容，发现插件异步完成并 `detail.resolve({空})` 之后，编辑器仍提交了一次**默认粘贴事务**（`id:""` 的 insert + 指向剪贴板**旧 docId** 的 block-ref），与插件通过 `appendBlock` 插入的新文档块冲突。

**根因 A（主因）**：`detail.resolve` 在 `createDoc`/`bindSubDocBlock` 全部跑完（约 500ms 后）才调用。SiYuan 在 `preventDefault` 之后等待 resolve 解除粘贴挂起；延迟 resolve 会让编辑器在解除挂起时仍按原始剪贴板内容走默认粘贴管线。

**根因 B（次因）**：`createCopiedSubDocForPaste` 直接调 `createDoc`，没有像 `createSubDocUnderParent` 那样提前 `creatingSubDocForParent.add(parentId)`，导致 `ws-create` 仍会触发 `onSubDocCreated` 走一遍绑定（虽被 join-inflight 挡住，但增加竞态面）。

**修复**：

1. 在 `handlePasteEvent` 判定接管文档块粘贴后，**同步** `preventDefault` + `detail.resolve({空})`，再启动异步 `finishDocClipboardPaste`；异步路径不再二次 resolve。
2. `createCopiedSubDocForPaste` 在 `createDoc` 前标记 `creatingSubDocForParent`，让 `onSubDocCreated(ws-create)` 跳过，绑定只由 `clipboard-copy-paste` 路径执行一次。

### v1.10.24 —— 真正根因：空字符串 resolve 无法覆盖剪贴板（有源码依据）

日志 `171936-dn635j` 显示：`txerr` 在 **sync resolve 后 15ms** 就出现，且早于 `copy-subdoc.start`。说明不是 createDoc/绑定的问题，而是 **resolve 本身没有挡住默认粘贴**。

对照思源官方 `app/src/protyle/util/paste.ts`：

```javascript
if (response?.textHTML) { textHTML = response.textHTML; }
if (response?.textPlain) { textPlain = response.textPlain; }
if (response?.siyuanHTML) { siyuanHTML = response.siyuanHTML; }
```

三处都用 **truthy 判断**。我们传的 `""` 全部被忽略，原 `siyuanHTML`（含旧文档块）继续走默认粘贴 → `id:""` insert + 旧 docId block-ref → `txerr`。

**修复**：新增 `resolvePasteNoop(detail)`，用零宽空格 `\u200b`（truthy、无害）同时覆盖 `textHTML/textPlain/siyuanHTML`，真正清空剪贴板语义；并增加 `fetch.transactions.submit` / `ws-main.txerr` 结构化日志便于后续定位。

### 下一步测试计划（需要用户配合）

请重启插件（产生新的会话日志），依次做以下最小动作，每做完一步观察一次是否正常，不要连续做多步再回来看日志：

1. 复制一个文档块，粘贴一次 -> 应该生成"原名(1)"的**新文档**，且不再弹出"invalid data tree"，日志里应该只有一次 `bind.append.done`（如果 ws-create 和 clipboard-copy-paste 都出现，应该有一条是 `bind.join-inflight` 而不是各自 `append.done`）。
2. 对同一个已复制的文档块，再粘贴一次 -> 应该**再生成一个独立的"原名(1)"新文档**（而不是指向第一次粘贴出来的同一个文档）。
   - 如果这一步仍然复现"多次粘贴指向同一文档"，说明问题不在事务冲突本身，而在 `docClipboardState` 没有在两次粘贴之间被正确保留/重置，需要针对性排查剪贴板状态机，而不是继续怀疑事务冲突。
3. 剪切一个文档块，粘贴到新位置 -> 应该是**同一个文档**从垃圾箱移出，标题不变。
4. 在正文里调整两个文档块的顺序 -> 观察文档树是否同步调整。
5. 在文档树里调整两个子文档的顺序 -> 观察正文文档块顺序是否同步调整。
6. 删除一个文档块 -> 观察对应文档是否移入「垃圾箱」。

把新一轮 `D:\LPX\Desktop\siyuanlog\latest.txt` 指向的日志文件给到下一轮排查即可，不需要额外操作。**注意**：如果某一步出问题但当前会话日志是空的（比如插件中途重载过），要像这次一样去 `D:\LPX\Desktop\siyuanlog` 目录里按时间戳找"出问题那一刻"对应的会话文件，而不是只看 `latest.txt`。

---

*最后更新：本文档由本轮对话整理生成，反映 `plugin.json` version 1.10.24 时的代码状态。后续如果按第 5 节方案重构，请同步更新本文件，保持"设计文档 = 当前实现"的一致性。*
