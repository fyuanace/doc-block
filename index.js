const { Plugin, Setting, fetchSyncPost, showMessage, openTab, getAllEditor, getModelByDockType } = require("siyuan");
let nodeFs = null;
let nodePath = null;
try {
    // Desktop/electron runtime only.
    nodeFs = require("fs");
    nodePath = require("path");
} catch {
    nodeFs = null;
    nodePath = null;
}

/**
 * sub-doc-block 架构（绑定线 vs 块内容）
 * - 持久化：思源 attributes 双属性（custom-doc-block + custom-doc-id）+ 子文档 custom-doc-block-id
 * - 运行时：blockToSubDoc 缓存 + enqueueSubDocSync(按子文档) + enqueueParentSync(按父文档)
 * - 绑定线：删块 → scheduleDocMove(trash)；撤销 insert 且子文档在回收站 → scheduleDocMove(restore)
 * - 块内容：writeDocBlockBinding 一次写入双向指针；重命名走 syncSubDocBlockTitle
 * - 移动：块移动 → syncSubDocToTargetParent；文档树移动 → moveSubDocBlockToDoc；父文档层定时 reconcile 顺序
 * - 创建入口：斜杠/文件树/ws-create/fetch-patch；插件 initiated 创建跳过 onSubDocCreated 重复绑块
 */
const PLUGIN_NAME = "sub-doc-block";
const ATTR_BLOCK = "custom-doc-block";
const ATTR_DOC_ID = "custom-doc-id";
const ATTR_DOC_BLOCK_ID = "custom-doc-block-id";
const STYLE_ID = "plugin-doc-block-style";
const DEFAULT_DOC_ICON_EMOJI = "\u{1F4C4}";
const TRASH_NOTEBOOK_NAME = "垃圾箱";
const TRASH_NOTEBOOK_LEGACY_NAMES = ["文档回收"];
const PLUGIN_LOG_DIR = "D:/LPX/Desktop/siyuanlog";
const DOC_CLIPBOARD_STORAGE_KEY = "__sub_doc_block_clipboard__";
const DOC_CLIPBOARD_MODE_COPY = "copy";
const DOC_CLIPBOARD_MODE_CUT = "cut";
const CONFIG_STORAGE = "config.json";
const DEFAULT_CONFIG = {
    docBlockHeadingLevel: 5,
    fileTreeClickToggle: true,
    autoClearTrashOnStartup: false,
    debugReconcile: false,
};
const DEDUPE_MS = 5000;
const SYNC_DEDUPE_MS = 800;
const TITLE_SYNC_DEBOUNCE_MS = 200;
/** 文档树/块双向移动去重窗口（fetch + ws 双通道） */
const MOVE_DEDUPE_MS = 1500;
/** 删块/撤块后移动子文档（进/出「垃圾箱」）的去抖；不修改块内容 */
const DOC_MOVE_DEBOUNCE_MS = 800;
const DELETE_GUARD_MS = 5000;
const MOVE_GUARD_MS = 5000;
const NOTEBOOK_ROOT_MOVE_KEY = "__notebook_root__";
const WS_LOG_CMDS = new Set(["create", "removeDoc", "rename", "savedoc", "transactions", "moveDoc"]);
const DOC_BLOCK_LABELS = "(?:文档块|文档|Document block|Document|Doc)";
const DOC_BLOCK_HEADING_MD = "(?:#{1,6}\\s+)?";

function safeSerialize(value) {
    if (value == null) {
        return value;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        try {
            return String(value);
        } catch {
            return "[unserializable]";
        }
    }
}

function getDocBlockHeadingLevel(plugin) {
    const level = Number(plugin?.config?.docBlockHeadingLevel);
    if (Number.isFinite(level) && level >= 0 && level <= 6) {
        return level;
    }
    return DEFAULT_CONFIG.docBlockHeadingLevel;
}

function getDocBlockHeadingPrefix(level) {
    if (!level || level <= 0) {
        return "";
    }
    return "#".repeat(level) + " ";
}
const DOC_BLOCK_MD_RE = new RegExp(
    `(?:${DOC_BLOCK_HEADING_MD})?(?:\`[^\`]+?\`|\\*\\*[^*]+?\\*\\*)\\s*[：:]?\\s*\\(\\(([^(]+?)\\s+"((?:\\\\.|[^"\\\\])*)\"\\)\\)\\{:[^}]*custom-doc-block=["']?1["']?[^}]*\\}`,
    "g",
);
const DOC_BLOCK_IAL_RE = /\(\(([^(]+?)\s+"((?:\\.|[^"\\])*)"\)\)\{:[^}]*custom-doc-block=["']?1["']?[^}]*\}/g;
const DOC_BLOCK_LABEL_REF_RE = new RegExp(
    `(?:${DOC_BLOCK_HEADING_MD})?(?:\`${DOC_BLOCK_LABELS}\\s*\`|\\*\\*${DOC_BLOCK_LABELS}\\*\\*)\\s*[：:]?\\s*\\(\\(([^(]+?)\\s+"((?:\\\\.|[^"\\\\])*)\"\\)\\)(?:\\s*\\{:[^}]*\\})?`,
    "g",
);
const DOC_BLOCK_PLAIN_LABEL_REF_RE = new RegExp(
    `(?:${DOC_BLOCK_HEADING_MD})?${DOC_BLOCK_LABELS}[：:]\\s*\\(\\(([^(]+?)\\s+"((?:\\\\.|[^"\\\\])*)\"\\)\\)(?:\\s*\\{:[^}]*\\})?`,
    "g",
);
const DOC_BLOCK_INLINE_CODE_IAL_RE = new RegExp(
    `(?:${DOC_BLOCK_HEADING_MD})\`([^\`]+?)\`\\s*\\{:[^}]*${ATTR_DOC_ID.replace(/-/g, "\\-")}=["']([^"'\\s]+)["']`,
    "g",
);

function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** 事务落库后再读 attributes / blocks，避免竞态 */
async function flushSqlTransaction() {
    await fetchSyncPost("/api/sqlite/flushTransaction", {});
}

async function waitForBlockRow(blockId, attempts = 6, intervalMs = 40) {
    if (!blockId) {
        return false;
    }
    for (let i = 0; i < attempts; i++) {
        const response = await fetchSyncPost("/api/query/sql", {
            stmt: `select id from blocks where id = '${escapeSqlLiteral(blockId)}' limit 1`,
        });
        if (response.code === 0 && response.data?.[0]?.id) {
            return true;
        }
        if (i === 1) {
            await fetchSyncPost("/api/sqlite/flushTransaction", {});
        }
        if (intervalMs > 0) {
            await sleep(intervalMs);
        }
    }
    return false;
}

async function isBlockRowPresent(blockId) {
    if (!blockId) {
        return false;
    }
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `select id from blocks where id = '${escapeSqlLiteral(blockId)}' limit 1`,
    });
    return response.code === 0 && !!response.data?.[0]?.id;
}

async function waitForBlockGone(blockId, attempts = 5, intervalMs = 40) {
    for (let i = 0; i < attempts; i++) {
        if (!(await isBlockRowPresent(blockId))) {
            return true;
        }
        if (i === 0) {
            await fetchSyncPost("/api/sqlite/flushTransaction", {});
        }
        if (intervalMs > 0 && i < attempts - 1) {
            await sleep(intervalMs);
        }
    }
    return !(await isBlockRowPresent(blockId));
}

async function ensureBlockReadyAfterSignal(blockId) {
    if (!blockId) {
        return false;
    }
    await fetchSyncPost("/api/sqlite/flushTransaction", {});
    if (await isBlockRowPresent(blockId)) {
        return true;
    }
    await sleep(30);
    await fetchSyncPost("/api/sqlite/flushTransaction", {});
    return isBlockRowPresent(blockId);
}

function isParentDocOpen(parentDocId) {
    if (!parentDocId) {
        return false;
    }
    return getAllEditor().some((editor) => editor?.protyle?.block?.rootID === parentDocId);
}

async function refreshParentProtyle(parentDocId) {
    if (!parentDocId || !isParentDocOpen(parentDocId)) {
        return;
    }
    const response = await fetchSyncPost("/api/ui/reloadProtyle", { id: parentDocId });
    console.log(`[${PLUGIN_NAME}]`, "reloadProtyle", parentDocId, response);
}

function parseIdsFromStoragePath(storagePath) {
    if (!storagePath) {
        return { subDocId: null, parentDocId: null };
    }
    const normalized = storagePath.replace(/^\/+/, "").replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0) {
        return { subDocId: null, parentDocId: null };
    }
    const subDocId = parts[parts.length - 1].replace(/\.sy$/, "");
    if (parts.length === 1) {
        return { subDocId, parentDocId: null };
    }
    const parentDocId = parts[parts.length - 2].replace(/\.sy$/, "");
    return { subDocId, parentDocId };
}

function buildChildStoragePath(parentStoragePath, subDocId) {
    const base = String(parentStoragePath || "/").replace(/\\/g, "/");
    const parentDir = base.replace(/\.sy$/, "");
    return `${parentDir}/${subDocId}.sy`;
}

function generateNodeId() {
    if (typeof Lute !== "undefined" && typeof Lute.NewNodeID === "function") {
        return Lute.NewNodeID();
    }
    const now = new Date();
    const pad = (n, len = 2) => String(n).padStart(len, "0");
    const stamp = [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds()),
    ].join("");
    const rand = Math.random().toString(36).slice(2, 9);
    return `${stamp}-${rand}`;
}

async function getDocumentRow(docId) {
    if (!docId) {
        return null;
    }
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `select id, content from blocks where id = '${escapeSqlLiteral(docId)}' and type = 'd' limit 1`,
    });
    if (response.code !== 0 || !response.data?.[0]) {
        return null;
    }
    return response.data[0];
}

async function getPathInfoByDocId(docId) {
    if (!docId) {
        return null;
    }
    const response = await fetchSyncPost("/api/filetree/getPathByID", { id: docId });
    if (response.code !== 0 || !response.data) {
        return null;
    }
    const data = response.data;
    return {
        notebook: data.notebook || data.box?.id || data.box || null,
        path: data.path || null,
    };
}

function getFilesPanel() {
    if (typeof getModelByDockType !== "function") {
        return null;
    }
    const file = getModelByDockType("file");
    if (!file?.selectItem || !file?.getLeaf) {
        return null;
    }
    return file;
}

async function selectDocTreeItem(docId, isSetCurrent = true) {
    if (!docId) {
        return null;
    }
    const file = getFilesPanel();
    if (!file) {
        console.warn(`[${PLUGIN_NAME}]`, "selectDocTreeItem file panel unavailable", docId);
        return null;
    }

    let notebookId = null;
    let path = null;
    const blockInfo = await fetchSyncPost("/api/block/getBlockInfo", { id: docId });
    if (blockInfo.code === 0 && blockInfo.data?.box && blockInfo.data?.path) {
        notebookId = blockInfo.data.box;
        path = blockInfo.data.path;
    } else {
        const pathInfo = await getPathInfoByDocId(docId);
        notebookId = pathInfo?.notebook || null;
        path = pathInfo?.path || null;
    }
    if (!notebookId || !path) {
        console.warn(`[${PLUGIN_NAME}]`, "selectDocTreeItem path missing", { docId, blockInfo });
        return null;
    }

    const liElement = await file.selectItem(notebookId, path, undefined, undefined, isSetCurrent);
    if (!liElement) {
        console.warn(`[${PLUGIN_NAME}]`, "selectDocTreeItem li missing", { docId, notebookId, path });
        return null;
    }
    return { file, notebookId, liElement };
}

function docIdFromFileTreeLi(liElement) {
    if (!liElement) {
        return null;
    }
    const nodeId = liElement.getAttribute("data-node-id");
    if (nodeId) {
        return nodeId;
    }
    const path = liElement.getAttribute("data-path");
    if (!path || !/\.sy$/i.test(path)) {
        return null;
    }
    const segment = path.split("/").filter(Boolean).pop();
    return segment ? segment.replace(/\.sy$/i, "") : null;
}

function isFileTreeChromeClickTarget(target) {
    return !!target?.closest?.(
        ".b3-list-item__toggle, .b3-list-item__arrow, .b3-list-item__action, .b3-list-item__icon",
    );
}

function bindFileTreeClick(plugin) {
    const file = getFilesPanel();
    if (!file?.element) {
        return false;
    }
    if (file.element.dataset.subDocTreeClickBound === "1") {
        return true;
    }
    file.element.dataset.subDocTreeClickBound = "1";
    file.element.addEventListener("click", (event) => {
        if (plugin.config?.fileTreeClickToggle === false) {
            return;
        }
        if (isFileTreeChromeClickTarget(event.target)) {
            return;
        }
        const liElement = event.target?.closest?.('li.b3-list-item[data-path][data-type="navigation-file"]');
        if (!liElement || !file.element.contains(liElement)) {
            return;
        }
        if (!docTreeItemHasChildren(liElement)) {
            return;
        }
        const toggle = liElement.querySelector(".b3-list-item__toggle");
        if (!toggle || toggle.classList.contains("fn__hidden")) {
            return;
        }
        // 不拦截思源原生单击打开文档；展开/折叠交给思源 toggle → getLeaf
        window.setTimeout(() => {
            toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }, 0);
    }, true);
    console.log(`[${PLUGIN_NAME}]`, "file tree click bound");
    return true;
}

function scheduleBindFileTreeClick(plugin) {
    if (bindFileTreeClick(plugin)) {
        return;
    }
    window.setTimeout(() => scheduleBindFileTreeClick(plugin), 300);
}

/** 思源 Files：子文档数 > 0 时折叠钮不带 fn__hidden */
function docTreeItemHasChildren(liElement) {
    const toggle = liElement?.querySelector(".b3-list-item__toggle");
    return !!toggle && !toggle.classList.contains("fn__hidden");
}

async function getHPathByDocId(docId) {
    if (!docId) {
        return null;
    }
    const response = await fetchSyncPost("/api/filetree/getHPathByID", { id: docId });
    if (response.code !== 0 || response.data == null) {
        return null;
    }
    return String(response.data).replace(/\\/g, "/");
}

function getActiveProtyleFromEditors() {
    const editors = getAllEditor();
    if (!editors.length) {
        return null;
    }
    const activeEl = document.activeElement;
    if (activeEl) {
        const fromActive = editors.find((editor) => editor?.protyle?.element?.contains?.(activeEl));
        if (fromActive?.protyle) {
            return fromActive.protyle;
        }
    }
    const selection = window.getSelection?.();
    const anchor = selection?.anchorNode;
    if (anchor) {
        const anchorEl = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
        const fromSelection = editors.find((editor) => editor?.protyle?.wysiwyg?.element?.contains?.(anchorEl));
        if (fromSelection?.protyle) {
            return fromSelection.protyle;
        }
    }
    const focusedProtyleEl = document.querySelector(".protyle.protyle--focus, .layout-tab-bar .item--focus + .fn__flex-1 .protyle");
    if (focusedProtyleEl) {
        const fromFocusClass = editors.find((editor) => editor?.protyle?.element === focusedProtyleEl
            || editor?.protyle?.element?.contains?.(focusedProtyleEl));
        if (fromFocusClass?.protyle) {
            return fromFocusClass.protyle;
        }
    }
    return editors[editors.length - 1]?.protyle || null;
}

function resolveCursorBlockId(protyle) {
    const wysiwyg = protyle?.wysiwyg?.element
        || protyle?.element?.querySelector?.(".protyle-wysiwyg");
    if (!wysiwyg) {
        return null;
    }
    const selection = window.getSelection?.();
    if (!selection?.rangeCount) {
        return null;
    }
    let anchor = selection.anchorNode;
    if (anchor?.nodeType === Node.TEXT_NODE) {
        anchor = anchor.parentElement;
    }
    const blockEl = anchor?.closest?.("[data-node-id]");
    const blockId = blockEl?.getAttribute?.("data-node-id") || null;
    const rootId = protyle?.block?.rootID || protyle?.block?.rootId || null;
    if (!blockId || blockId === rootId) {
        return null;
    }
    return blockId;
}

function getProtyleFromNode(nodeElement) {
    if (!nodeElement) {
        return null;
    }
    const wysiwyg = nodeElement.closest?.(".protyle-wysiwyg");
    if (wysiwyg) {
        return getProtyleFromWysiwyg(wysiwyg);
    }
    const protyleEl = nodeElement.closest?.(".protyle");
    if (!protyleEl) {
        return null;
    }
    const editor = getAllEditor().find((item) => item?.protyle?.element === protyleEl
        || item?.protyle?.element?.contains?.(protyleEl));
    return editor?.protyle || null;
}

async function resolveSlashProtyleContext(protyle, nodeElement) {
    const activeProtyle = (nodeElement ? getProtyleFromNode(nodeElement) : null)
        || protyle
        || getActiveProtyleFromEditors();

    const triggerBlockId = resolveSlashTriggerBlockId(activeProtyle || protyle, nodeElement)
        || resolveCursorBlockId(activeProtyle || protyle);

    let block = activeProtyle?.block
        || protyle?.block
        || protyle?.protyle?.block
        || protyle?.getInstance?.()?.block
        || null;

    if (!block && nodeElement) {
        const hostEditor = getAllEditor().find((editor) => editor?.protyle?.element?.contains?.(nodeElement));
        block = hostEditor?.protyle?.block || null;
    }

    const blockId = triggerBlockId || block?.id || null;

    let rootDocId = null;
    if (triggerBlockId) {
        rootDocId = await getBlockRootId(triggerBlockId);
    }
    if (!rootDocId && block) {
        rootDocId = block.rootID || block.rootId || null;
    }
    if (!rootDocId && blockId) {
        rootDocId = await getBlockRootId(blockId);
    }

    return { block, blockId, rootDocId, protyle: activeProtyle || protyle || null };
}

function resolveSlashTriggerBlockId(protyle, nodeElement) {
    if (nodeElement) {
        const fromNode = nodeElement.getAttribute?.("data-node-id")
            || nodeElement.closest?.("[data-node-id]")?.getAttribute("data-node-id");
        if (fromNode) {
            const rootId = protyle?.block?.rootID || protyle?.block?.rootId || null;
            if (!rootId || fromNode !== rootId) {
                return fromNode;
            }
        }
    }
    const fromCursor = resolveCursorBlockId(protyle);
    if (fromCursor) {
        return fromCursor;
    }
    const blockId = protyle?.block?.id || protyle?.getInstance?.()?.block?.id || null;
    const rootId = protyle?.block?.rootID || protyle?.block?.rootId || null;
    if (blockId && blockId !== rootId) {
        return blockId;
    }
    return null;
}

function clearSlashTextInBlock(nodeElement) {
    if (!nodeElement) {
        return;
    }
    const editable = nodeElement.querySelector?.('[contenteditable="true"]');
    if (!editable) {
        return;
    }
    const raw = editable.textContent || "";
    const text = cleanTitle(raw).replace(/^\/+/, "").trim();
    if (isSlashTriggerContent(raw, text)) {
        editable.textContent = "";
    }
}

function getBlockEditElement(blockElement) {
    if (!blockElement) {
        return null;
    }
    if (blockElement.classList.contains("protyle-title__input")) {
        return blockElement;
    }
    if (blockElement.getAttribute("contenteditable") === "true") {
        return blockElement;
    }
    return blockElement.querySelector('[contenteditable="true"]');
}

function getRangeOffsetInElement(editElement, range) {
    if (!editElement || !range) {
        return { start: 0, end: 0 };
    }
    try {
        const startRange = range.cloneRange();
        startRange.selectNodeContents(editElement);
        startRange.setEnd(range.startContainer, range.startOffset);
        const start = startRange.toString().length;
        return { start, end: start + range.toString().length };
    } catch {
        return { start: 0, end: 0 };
    }
}

function resolveBackStackBlockElement(protyle, blockId, nodeElement) {
    if (nodeElement?.closest) {
        const fromNode = nodeElement.closest("[data-node-id]");
        if (fromNode) {
            return fromNode;
        }
    }
    if (blockId && protyle?.wysiwyg?.element) {
        return protyle.wysiwyg.element.querySelector(`[data-node-id="${blockId}"]`);
    }
    return null;
}

/**
 * 插件 openTab 打开子文档时，思源不会把父文档当前光标压入 backStack。
 * 侧键/工具栏后退因此会跳过父文档，落到更早的历史位置。
 * 这里按思源 pushBack 的结构补一条记录。
 */
function pushProtyleBackStack(protyle, blockId, nodeElement) {
    if (!protyle?.model || !Array.isArray(window.siyuan?.backStack)) {
        return false;
    }
    const blockElement = resolveBackStackBlockElement(protyle, blockId, nodeElement);
    const editElement = getBlockEditElement(blockElement);
    if (!blockElement || !editElement) {
        return false;
    }

    const id = blockElement.getAttribute("data-node-id") || protyle.block?.rootID;
    if (!id) {
        return false;
    }

    const selection = document.getSelection();
    let range = null;
    if (selection?.rangeCount > 0) {
        const selRange = selection.getRangeAt(0);
        if (blockElement.contains(selRange.startContainer)) {
            range = selRange;
        }
    }
    if (!range && protyle.toolbar?.range && blockElement.contains(protyle.toolbar.range.startContainer)) {
        range = protyle.toolbar.range;
    }
    const position = range
        ? getRangeOffsetInElement(editElement, range)
        : { start: editElement.textContent?.length || 0, end: editElement.textContent?.length || 0 };

    const zoomId = protyle.block?.showAll ? protyle.block.id : undefined;
    const backStack = window.siyuan.backStack;
    const lastStack = backStack[backStack.length - 1];
    const sameBlock = lastStack && lastStack.id === id && (
        (protyle.block?.showAll && lastStack.zoomId === protyle.block.id)
        || (!lastStack.zoomId && !protyle.block?.showAll)
    );
    if (sameBlock) {
        lastStack.position = position;
        lastStack.protyle = protyle;
        return true;
    }

    backStack.push({
        position,
        id,
        protyle,
        zoomId,
    });
    const maxSize = window.siyuan?.config?.editor?.historyCount || 64;
    if (backStack.length > maxSize) {
        backStack.shift();
    }
    document.querySelector("#barBack")?.classList.remove("toolbar__item--disabled");
    return true;
}

function syncSlashToolbarRange(protyle, nodeElement) {
    if (!protyle || !nodeElement) {
        return;
    }
    const editable = nodeElement.querySelector?.('[contenteditable="true"]');
    if (!editable) {
        return;
    }
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    if (!protyle.toolbar) {
        protyle.toolbar = {};
    }
    protyle.toolbar.range = range;
}

async function lsNotebooks() {
    const response = await fetchSyncPost("/api/notebook/lsNotebooks", {});
    if (response.code !== 0) {
        return [];
    }
    return response.data?.notebooks || [];
}

async function findNotebookByName(name) {
    const notebooks = await lsNotebooks();
    return notebooks.find((notebook) => notebook.name === name) || null;
}

async function findTrashNotebook() {
    const primary = await findNotebookByName(TRASH_NOTEBOOK_NAME);
    if (primary?.id) {
        return primary;
    }
    for (const legacyName of TRASH_NOTEBOOK_LEGACY_NAMES) {
        const legacy = await findNotebookByName(legacyName);
        if (legacy?.id) {
            return legacy;
        }
    }
    return null;
}

async function waitForTrashNotebook(attempts = 10, intervalMs = 150) {
    for (let i = 0; i < attempts; i++) {
        const notebook = await findTrashNotebook();
        if (notebook?.id) {
            return notebook;
        }
        await sleep(intervalMs);
    }
    return null;
}

async function waitForNotebookByName(name, attempts = 10, intervalMs = 150) {
    for (let i = 0; i < attempts; i++) {
        const notebook = await findNotebookByName(name);
        if (notebook?.id) {
            return notebook;
        }
        await sleep(intervalMs);
    }
    return null;
}

async function isDocumentPresent(docId) {
    return !!(await getDocumentRow(docId));
}

async function getDocNotebookIdFromSql(docId) {
    if (!docId) {
        return null;
    }
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `select box from blocks where id = '${escapeSqlLiteral(docId)}' and type = 'd' limit 1`,
    });
    return response.data?.[0]?.box || null;
}

async function listDocIdsInNotebook(notebookId) {
    if (!notebookId) {
        return [];
    }
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `select id from blocks where box = '${escapeSqlLiteral(notebookId)}' and type = 'd'`,
    });
    if (response.code !== 0 || !Array.isArray(response.data)) {
        return [];
    }
    return response.data.map((row) => row.id).filter(Boolean);
}

async function isTrashDocReferenced(docId) {
    if (!docId) {
        return false;
    }
    const primaryBlockId = await getPrimaryDocBlockId(docId);
    if (primaryBlockId && await isBlockRowPresent(primaryBlockId)) {
        return true;
    }
    const escapedDocId = escapeSqlLiteral(docId);
    const refResponse = await fetchSyncPost("/api/query/sql", {
        stmt: `select count(*) as c from refs where def_block_id = '${escapedDocId}'`,
    });
    if (refResponse.code === 0 && Number(refResponse.data?.[0]?.c) > 0) {
        return true;
    }
    const contentResponse = await fetchSyncPost("/api/query/sql", {
        stmt: `
            select id from blocks
            where id != '${escapedDocId}'
            and (markdown like '%((${escapedDocId} %' or content like '%((${escapedDocId} %')
            limit 1
        `,
    });
    return contentResponse.code === 0 && Array.isArray(contentResponse.data) && contentResponse.data.length > 0;
}

async function resolveParentDocIdFromSql(subDocId) {
    if (!subDocId) {
        return null;
    }
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `select path from blocks where id = '${escapeSqlLiteral(subDocId)}' and type = 'd' limit 1`,
    });
    const path = response.data?.[0]?.path;
    if (!path) {
        return null;
    }
    return parseIdsFromStoragePath(path).parentDocId;
}

async function isSubDocAtNotebookRoot(subDocId) {
    if (!subDocId || !(await isDocumentPresent(subDocId))) {
        return false;
    }
    return !(await resolveParentDocIdFromSql(subDocId));
}

async function getDocNotebookId(docId) {
    const notebookId = await getDocNotebookIdFromSql(docId);
    if (notebookId) {
        return notebookId;
    }
    const pathInfo = await getPathInfoByDocId(docId);
    return pathInfo?.notebook || null;
}

async function resolveParentDocId(subDocId, fallbackParentDocId = null) {
    if (fallbackParentDocId) {
        const parentRow = await getDocumentRow(fallbackParentDocId);
        if (parentRow) {
            return parentRow.id;
        }
    }
    const fromSql = await resolveParentDocIdFromSql(subDocId);
    if (fromSql) {
        return fromSql;
    }
    if (!(await isDocumentPresent(subDocId))) {
        return null;
    }
    for (let i = 0; i < 10; i++) {
        const pathInfo = await getPathInfoByDocId(subDocId);
        const { parentDocId } = parseIdsFromStoragePath(pathInfo?.path);
        if (parentDocId) {
            const parentRow = await getDocumentRow(parentDocId);
            if (parentRow) {
                return parentRow.id;
            }
        }
        await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    return null;
}

function docIdFromStoragePath(storagePath) {
    return parseIdsFromStoragePath(storagePath).subDocId;
}

function escapeMarkdownText(text) {
    return String(text ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\{/g, "\\{")
        .replace(/\}/g, "\\}");
}

function escapeSqlLiteral(value) {
    return String(value ?? "").replace(/'/g, "''");
}

function cleanTitle(text) {
    return String(text ?? "")
        .replace(/\{:.*?\}/g, "")
        .replace(/\{:\s*[^}]+\}/g, "")
        .replace(/^#\s*/, "")
        .trim();
}

function setDocClipboardState(state) {
    if (!state || !state.mode || !state.subDocId) {
        return;
    }
    const normalized = {
        mode: state.mode,
        subDocId: String(state.subDocId),
        sourceTitle: cleanTitle(state.sourceTitle || ""),
        sourceBlockId: state.sourceBlockId ? String(state.sourceBlockId) : null,
        sourceParentDocId: state.sourceParentDocId ? String(state.sourceParentDocId) : null,
        updatedAt: Date.now(),
    };
    window.__subDocBlockClipboardState = normalized;
    try {
        window.sessionStorage?.setItem(DOC_CLIPBOARD_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
        // ignore storage failures
    }
    console.log(`[${PLUGIN_NAME}]`, "clipboard.set", {
        mode: normalized.mode,
        subDocId: normalized.subDocId,
        sourceBlockId: normalized.sourceBlockId,
        sourceParentDocId: normalized.sourceParentDocId,
    });
}

function getDocClipboardState() {
    const inMemory = window.__subDocBlockClipboardState;
    if (inMemory?.mode && inMemory?.subDocId) {
        return inMemory;
    }
    try {
        const raw = window.sessionStorage?.getItem(DOC_CLIPBOARD_STORAGE_KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw);
        if (!parsed?.mode || !parsed?.subDocId) {
            return null;
        }
        window.__subDocBlockClipboardState = parsed;
        console.log(`[${PLUGIN_NAME}]`, "clipboard.restore-from-session", {
            mode: parsed.mode,
            subDocId: parsed.subDocId,
        });
        return parsed;
    } catch {
        return null;
    }
}

function clearDocClipboardState() {
    delete window.__subDocBlockClipboardState;
    try {
        window.sessionStorage?.removeItem(DOC_CLIPBOARD_STORAGE_KEY);
    } catch {
        // ignore storage failures
    }
    console.log(`[${PLUGIN_NAME}]`, "clipboard.clear");
}

function clipboardHasCorruptedDocBlockDom(siyuanHTML, textHTML, textPlain) {
    const hay = `${siyuanHTML || ""}${textHTML || ""}${textPlain || ""}`;
    return /data-sub-doc-readonly/.test(hay)
        || /<div[^>]*contenteditable=["']false["'][^>]*>[^<]*📄/i.test(hay);
}

/**
 * 粘贴意图：优先 session 状态；否则从剪贴板内容推断「文档块复制」。
 * 避免 session 丢失时走 processPasteContent（只改块引、不新建文档，或 siyuanHTML 为空导致回退到损坏 HTML）。
 */
function inferDocBlockPasteState(detail) {
    const stored = getDocClipboardState();
    if (stored?.subDocId && stored?.mode) {
        return stored;
    }
    if (!detail) {
        return null;
    }
    const refs = extractDocRefsFromClipboard(detail.siyuanHTML, detail.textHTML, detail.textPlain);
    if (refs.length !== 1) {
        return null;
    }
    const shouldDuplicate = clipboardHasCorruptedDocBlockDom(detail.siyuanHTML, detail.textHTML, detail.textPlain)
        || clipboardHayHasDocBlockBinding(detail.siyuanHTML, detail.textHTML, detail.textPlain)
        || clipboardHasDocBlockMarkup(detail.siyuanHTML, detail.textHTML, detail.textPlain)
        || clipboardIsOnlyDocBlocks(detail.siyuanHTML, detail.textHTML, detail.textPlain);
    if (!shouldDuplicate) {
        return null;
    }
    return {
        mode: DOC_CLIPBOARD_MODE_COPY,
        subDocId: refs[0].docId,
        sourceTitle: refs[0].title,
        sourceBlockId: null,
        sourceParentDocId: null,
        inferred: true,
    };
}

function resolvePasteDocTitle(sourceTitle) {
    return cleanTitle(sourceTitle || "未命名") || "未命名";
}

function parseTitleFromDocBlockCodeText(text, blockLabel) {
    const raw = cleanTitle(text);
    if (!raw) {
        return "未命名";
    }
    const candidates = [
        String(blockLabel || "").trim(),
        "文档:",
        "文档：",
        "文档块:",
        "Document:",
        "Doc:",
    ].filter(Boolean);
    for (const label of candidates) {
        const withSpace = `${label} `;
        if (raw.startsWith(withSpace)) {
            return cleanTitle(raw.slice(withSpace.length)) || "未命名";
        }
        if (raw === label) {
            return "未命名";
        }
        if (raw.startsWith(label)) {
            return cleanTitle(raw.slice(label.length)) || "未命名";
        }
    }
    const loose = raw.match(new RegExp(`^(?:${DOC_BLOCK_LABELS})\\s*[：:]?\\s*(.+)$`));
    if (loose?.[1]) {
        return cleanTitle(loose[1]) || "未命名";
    }
    return raw;
}

async function getDocIconHex(docId) {
    if (!docId) {
        return null;
    }
    const response = await fetchSyncPost("/api/attr/getBlockAttrs", { id: docId });
    if (response.code !== 0 || !response.data?.icon) {
        return null;
    }
    return String(response.data.icon);
}

function docIconHexToEmoji(iconHex) {
    if (!iconHex || !/^[0-9a-fA-F]+$/.test(iconHex)) {
        return null;
    }
    const codePoint = parseInt(iconHex, 16);
    if (!Number.isFinite(codePoint) || codePoint <= 0) {
        return null;
    }
    try {
        return String.fromCodePoint(codePoint);
    } catch {
        return null;
    }
}

async function buildDocIconPrefix(docId) {
    const emoji = docIconHexToEmoji(await getDocIconHex(docId));
    if (emoji) {
        return `${emoji} `;
    }
    return `${DEFAULT_DOC_ICON_EMOJI} `;
}

async function buildSubDocBlockMarkdown(subDocId, title, headingLevel = DEFAULT_CONFIG.docBlockHeadingLevel) {
    const safeTitle = escapeMarkdownText(cleanTitle(title) || "未命名");
    const iconPrefix = await buildDocIconPrefix(subDocId);
    return `${getDocBlockHeadingPrefix(headingLevel)}${iconPrefix}((${subDocId} "${safeTitle}"))`;
}

async function getBlockTypeRow(blockId) {
    if (!blockId) {
        return null;
    }
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `select id, type, subtype from blocks where id = '${escapeSqlLiteral(blockId)}' limit 1`,
    });
    if (response.code !== 0 || !response.data?.[0]) {
        return null;
    }
    return response.data[0];
}

function isParagraphBlockType(row) {
    if (!row) {
        return false;
    }
    const type = String(row.type || "").toLowerCase();
    return type === "p" || type === "paragraph";
}

/** 按目标块类型生成 markdown，段落块不用标题前缀，避免 updateBlock 在下一行另起标题块 */
async function buildSubDocBlockMarkdownForBlock(subDocId, title, headingLevel, blockId) {
    const safeTitle = escapeMarkdownText(cleanTitle(title) || "未命名");
    const iconPrefix = await buildDocIconPrefix(subDocId);
    const ref = `${iconPrefix}((${subDocId} "${safeTitle}"))`;
    if (!blockId) {
        return `${getDocBlockHeadingPrefix(headingLevel)}${ref}`;
    }
    const row = await getBlockTypeRow(blockId);
    if (isParagraphBlockType(row) || headingLevel <= 0) {
        return ref;
    }
    const type = String(row?.type || "").toLowerCase();
    if (type === "h" || type === "heading") {
        const subtype = String(row?.subtype || "");
        const match = subtype.match(/^h([1-6])$/i);
        if (match) {
            return `${"#".repeat(parseInt(match[1], 10))} ${ref}`;
        }
    }
    return `${getDocBlockHeadingPrefix(headingLevel)}${ref}`;
}

function shouldReplaceTriggerBlock(source) {
    const s = String(source || "");
    return s.includes("slash") || s.includes("clipboard");
}

async function finalizeDocBlockPresentation(plugin, blockId, subDocId) {
    if (!blockId || !subDocId) {
        return false;
    }
    const bound = await writeDocBlockBinding(blockId, subDocId);
    if (!bound) {
        return false;
    }
    plugin.rememberBlockSubDoc(blockId, subDocId);
    plugin.markRecentBoundSubDoc(subDocId, blockId);

    const apply = () => {
        const blockEl = document.querySelector(`[data-node-id="${blockId}"]`);
        if (blockEl) {
            decorateSubDocBlocks(blockEl, plugin);
        }
        return blockEl?.classList?.contains("sub-doc-block");
    };

    apply();
    await sleep(40);
    apply();
    window.requestAnimationFrame(() => apply());

    const pendingTitle = plugin.pendingTitleSync.get(subDocId);
    if (pendingTitle) {
        plugin.pendingTitleSync.delete(subDocId);
        plugin.scheduleSubDocBlockTitleSync(subDocId, pendingTitle, "bind-flush");
    }
    return true;
}

function syncToolbarRangeOnBlock(protyle, blockId, nodeElement = null) {
    if (!protyle) {
        return;
    }
    const blockEl = nodeElement?.closest?.("[data-node-id]")
        || document.querySelector(`[data-node-id="${blockId}"]`);
    if (!blockEl) {
        return;
    }
    const editable = getBlockEditElement(blockEl);
    if (!editable) {
        return;
    }
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    if (!protyle.toolbar) {
        protyle.toolbar = {};
    }
    protyle.toolbar.range = range;
    try {
        const selection = document.getSelection();
        if (selection) {
            selection.removeAllRanges();
            selection.addRange(range.cloneRange());
        }
    } catch {
        // ignore selection errors in edge layouts
    }
}

function getDocBlockContentScope(blockEl) {
    return blockEl?.querySelector('[contenteditable="true"]') || blockEl;
}

function isDocBlockLike(blockEl) {
    if (!blockEl) {
        return false;
    }
    if (blockEl.classList.contains("sub-doc-block")) {
        return true;
    }
    if (isPrimaryDocBlockElement(blockEl)) {
        return true;
    }
    if (readCustomAttr(blockEl, ATTR_BLOCK) === "1" && readDocIdFromElement(blockEl)) {
        return true;
    }
    return !!blockEl.querySelector(`[${ATTR_BLOCK}="1"], [data-${ATTR_BLOCK}="1"]`);
}

function getPreviousBlockElement(blockEl) {
    if (!blockEl) {
        return null;
    }
    let prev = blockEl.previousElementSibling;
    while (prev) {
        if (prev.getAttribute?.("data-node-id")) {
            return prev;
        }
        const nested = prev.querySelector?.(":scope > [data-node-id]");
        if (nested) {
            return nested;
        }
        prev = prev.previousElementSibling;
    }
    return null;
}

function getNextBlockElement(blockEl) {
    if (!blockEl) {
        return null;
    }
    let next = blockEl.nextElementSibling;
    while (next) {
        if (next.getAttribute?.("data-node-id")) {
            return next;
        }
        const nested = next.querySelector?.(":scope > [data-node-id]");
        if (nested) {
            return nested;
        }
        next = next.nextElementSibling;
    }
    return null;
}

function getCaretOffsetInBlock(blockEl) {
    const editElement = getBlockEditElement(blockEl);
    if (!editElement) {
        return 0;
    }
    const selection = document.getSelection();
    if (!selection?.rangeCount) {
        return 0;
    }
    const range = selection.getRangeAt(0);
    if (!blockEl.contains(range.startContainer)) {
        return 0;
    }
    return getRangeOffsetInElement(editElement, range).start;
}

function docBlockPresentationIsCorrupted(blockEl) {
    if (!blockEl) {
        return false;
    }
    const refEl = blockEl.querySelector('span[data-type*="block-ref"]');
    const html = blockEl.innerHTML || "";
    const text = blockEl.textContent || "";
    if (/&lt;div/i.test(html) || /contenteditable="false"/i.test(text)) {
        return true;
    }
    if (blockEl.querySelector("div[data-sub-doc-readonly]") && !refEl) {
        return true;
    }
    if (refEl && (refEl.getAttribute("data-type") || "").includes("code")) {
        return true;
    }
    return !isCorrectDocBlockPresentation(blockEl);
}

function handleDocBlockEditorKeydown(event) {
    const wysiwyg = event.target?.closest?.(".protyle-wysiwyg");
    if (!wysiwyg) {
        return;
    }

    const blockEl = event.target?.closest?.("[data-node-id]");
    if (!blockEl) {
        return;
    }

    const key = event.key;
    const isPrintable = key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;

    if (isDocBlockLike(blockEl)) {
        if (isPrintable || key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        if (key === "Backspace") {
            if (getCaretOffsetInBlock(blockEl) > 0) {
                event.preventDefault();
                event.stopPropagation();
            }
            return;
        }
        if (key === "Delete") {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
    }

    if (key !== "Backspace" && key !== "Delete") {
        return;
    }

    const selection = document.getSelection();
    if (!selection?.rangeCount || !selection.getRangeAt(0).collapsed) {
        return;
    }

    if (key === "Backspace" && getCaretOffsetInBlock(blockEl) === 0) {
        const prevBlock = getPreviousBlockElement(blockEl);
        if (isDocBlockLike(prevBlock)) {
            event.preventDefault();
            event.stopPropagation();
        }
    }
}

function docBlockHasBrokenChipMarkup(blockEl) {
    if (!blockEl) {
        return false;
    }
    const html = blockEl.innerHTML || "";
    const text = blockEl.textContent || "";
    return /sub-doc-block-chip/.test(text)
        || /sub-doc-block-chip/.test(html)
        || /&lt;div[^>]*sub-doc-block-chip/.test(html)
        || /<div[^>]*sub-doc-block-chip/.test(html);
}

function isCorrectDocBlockPresentation(blockEl) {
    const refEl = blockEl?.querySelector('span[data-type*="block-ref"]');
    if (!refEl || (refEl.getAttribute("data-type") || "").includes("code")) {
        return false;
    }
    if (!readDocIdFromElement(blockEl)) {
        return false;
    }
    if (docBlockHasBrokenChipMarkup(blockEl)) {
        return false;
    }
    const html = blockEl.innerHTML || "";
    const text = blockEl.textContent || "";
    if (/&lt;div/i.test(html) || /contenteditable="false"/i.test(text)) {
        return false;
    }
    if (blockEl.querySelector("div[data-sub-doc-readonly]")) {
        return false;
    }
    return true;
}

function docBlockDomNeedsPresentationUpgrade(blockEl) {
    if (!blockEl) {
        return false;
    }
    if (isCorrectDocBlockPresentation(blockEl)) {
        return false;
    }
    if (!isPrimaryDocBlockElement(blockEl)) {
        return false;
    }
    if (blockEl.querySelector("div[data-sub-doc-readonly]")) {
        return true;
    }
    if (blockEl.querySelector('span[data-type="code"], code')) {
        return true;
    }
    const refEl = blockEl.querySelector('span[data-type*="block-ref"]');
    if (refEl && (refEl.getAttribute("data-type") || "").includes("code")) {
        return true;
    }
    if (new RegExp(DOC_BLOCK_LABELS).test(blockEl.textContent || "")) {
        return true;
    }
    if (docBlockHasBrokenChipMarkup(blockEl)) {
        return true;
    }
    return false;
}

function docBlockTextmarkNeedsPresentationUpgrade(textmark) {
    const s = String(textmark || "");
    if (!s.includes(ATTR_BLOCK) && !s.includes(ATTR_DOC_ID) && !markdownLooksLikeDocBlock(s)) {
        return false;
    }
    if (isNativeDocBlockMarkdown(s)) {
        return false;
    }
    if (/data-sub-doc-readonly|sub-doc-block-chip|<div class=/.test(s)) {
        return true;
    }
    if (/data-type="code"/.test(s) || /block-ref code/.test(s)) {
        return true;
    }
    if (new RegExp(DOC_BLOCK_LABELS).test(s)) {
        return true;
    }
    return /#{5}\s+\*\*/.test(s) || /`/.test(s);
}

function isNativeDocBlockMarkdown(text) {
    const s = String(text || "");
    if (/data-sub-doc-readonly|sub-doc-block-chip|<div class=/.test(s)) {
        return false;
    }
    if (/`/.test(s) || new RegExp(DOC_BLOCK_LABELS).test(s)) {
        return false;
    }
    if (/block-ref code/.test(s) || /data-type="code"/.test(s)) {
        return false;
    }
    const hasRef = /data-type="block-ref"/.test(s) || /\(\([^(]+?\s+"[^"]+"\)\)/.test(s);
    if (!hasRef) {
        return false;
    }
    return /#{5}/.test(s) || s.includes("NodeHeading");
}

function docBlockMarkdownNeedsPresentationUpgrade(kramdown) {
    const s = String(kramdown || "");
    if (!markdownLooksLikeDocBlock(s)) {
        return false;
    }
    if (isNativeDocBlockMarkdown(s)) {
        return false;
    }
    if (/data-sub-doc-readonly|sub-doc-block-chip|<div class=/.test(s)) {
        return true;
    }
    if (/`/.test(s) || /#{5}\s+\*\*/.test(s) || /\*\*[^*]+?\*\*/.test(s)) {
        return true;
    }
    if (new RegExp(DOC_BLOCK_LABELS).test(s)) {
        return true;
    }
    if (DOC_BLOCK_PLAIN_LABEL_REF_RE.test(s) || DOC_BLOCK_LABEL_REF_RE.test(s)) {
        return true;
    }
    return true;
}

const SLASH_FILTER_TERMS = ["子文档", "文档", "文档块", "zwd", "subdoc", "sub-doc", "ziwd", "doc", "z"];

function isSlashTriggerContent(raw, text) {
    const normalized = (text || cleanTitle(raw).replace(/^\/+/, "").trim()).toLowerCase();
    if (!normalized) {
        return true;
    }
    const rawTrim = String(raw || "").trim();
    if (/^\/[\w\u4e00-\u9fff]{0,12}$/.test(rawTrim)) {
        return true;
    }
    for (const term of SLASH_FILTER_TERMS) {
        const lowerTerm = term.toLowerCase();
        if (lowerTerm.startsWith(normalized) || normalized.startsWith(lowerTerm)) {
            if (normalized.length <= lowerTerm.length) {
                return true;
            }
        }
    }
    return /^(子文档|文档|文档块|zwd|subdoc|sub-doc|ziwd|doc|z)?$/i.test(normalized);
}

function markdownLooksLikeDocBlock(text) {
    const s = String(text || "");
    return s.includes(ATTR_BLOCK) && s.includes(ATTR_DOC_ID)
        || DOC_BLOCK_LABEL_REF_RE.test(s)
        || DOC_BLOCK_PLAIN_LABEL_REF_RE.test(s)
        || DOC_BLOCK_INLINE_CODE_IAL_RE.test(s)
        || new RegExp(`(?:${DOC_BLOCK_HEADING_MD})\`${DOC_BLOCK_LABELS}`).test(s)
        || /data-type="block-ref code"/.test(s)
        || new RegExp(`(?:${DOC_BLOCK_HEADING_MD})?\\*\\*${DOC_BLOCK_LABELS}\\*\\*`).test(s)
        || /sub-doc-block-chip/.test(s);
}

function stripVisibleIal(text) {
    if (!text) {
        return text;
    }
    return String(text)
        .replace(/\{:[^}]*\}/g, "")
        .replace(/\{:\s*\}/g, "");
}

function buildDocRefMarkdown(docId, title) {
    const safeTitle = escapeMarkdownText(cleanTitle(title) || "未命名");
    return `((${docId} "${safeTitle}"))`;
}

const DOC_BLOCK_HEADING_REF_MD_RE = new RegExp(
    `(?:${DOC_BLOCK_HEADING_MD})(?:\`${DOC_BLOCK_LABELS}\\s*\`|\\*\\*[^*]+\\*\\*\\s*[：:]?\\s*)?\\(\\(([^(]+?)\\s+"((?:\\\\.|[^"\\\\])*)\"\\)\\)`,
    "g",
);

function clipboardHasDocBlockMarkup(siyuanHTML, textHTML, textPlain) {
    const hay = `${siyuanHTML || ""}${textHTML || ""}${textPlain || ""}`;
    if (!hay) {
        return false;
    }
    if (markdownLooksLikeDocBlock(hay)) {
        return true;
    }
    if (/data-custom-doc-block|custom-doc-block=["']1["']/.test(hay)) {
        return true;
    }
    if (/data-custom-doc-block|custom-doc-block=["']1["']/.test(hay)) {
        return true;
    }
    if (/sub-doc-block/.test(hay)) {
        return true;
    }
    if (/data-type=["']NodeHeading["']/i.test(hay) && /data-subtype=["']h[1-6]["']/i.test(hay)) {
        if (/data-custom-doc-block|custom-doc-block=["']1["']/.test(hay)) {
            return true;
        }
        if (/block-ref/i.test(hay)) {
            return true;
        }
    }
    if (/data-type=["']NodeParagraph["']/i.test(hay) && /data-custom-doc-block|custom-doc-block=["']1["']/.test(hay)) {
        return true;
    }
    return false;
}

function extractDocRefsFromHtmlString(html, addRef) {
    if (!html) {
        return;
    }
    const root = new DOMParser().parseFromString(html, "text/html");

    root.querySelectorAll(`[${ATTR_DOC_ID}], [data-${ATTR_DOC_ID}]`).forEach((el) => {
        const docId = readCustomAttr(el, ATTR_DOC_ID);
        const scope = el.closest('[data-type="NodeHeading"]') || el.closest("[data-node-id]") || el;
        const codeEl = scope.querySelector?.('span[data-type="code"]:not([data-type*="block-ref"]), code');
        const refEl = scope.querySelector?.('span[data-type*="block-ref"]');
        let title;
        if (refEl) {
            title = parseTitleFromDocBlockCodeText(refEl.textContent);
        } else if (codeEl) {
            title = parseTitleFromDocBlockCodeText(codeEl.textContent);
        } else {
            title = parseTitleFromDocBlockCodeText(scope.textContent);
        }
        addRef(docId, title);
    });

    root.querySelectorAll(".sub-doc-block, [data-type=\"NodeHeading\"][data-subtype^=\"h\"], [data-type=\"NodeParagraph\"].sub-doc-block").forEach((el) => {
        const docId = readDocIdFromElement(el);
        const codeEl = el.querySelector('span[data-type="code"]:not([data-type*="block-ref"]), code');
        const refEl = el.querySelector('span[data-type*="block-ref"]');
        if (docId) {
            if (refEl) {
                addRef(docId, parseTitleFromDocBlockCodeText(refEl.textContent));
            } else if (codeEl) {
                addRef(docId, parseTitleFromDocBlockCodeText(codeEl.textContent));
            } else {
                addRef(docId, el.textContent);
            }
            return;
        }
        if (refEl?.getAttribute("data-subtype") === "d") {
            addRef(refEl.getAttribute("data-id"), parseTitleFromDocBlockCodeText(refEl.textContent));
        }
    });
}

function extractDocRefsFromMarkdown(hay, addRef) {
    if (!hay) {
        return;
    }
    DOC_BLOCK_INLINE_CODE_IAL_RE.lastIndex = 0;
    let inlineMatch;
    while ((inlineMatch = DOC_BLOCK_INLINE_CODE_IAL_RE.exec(hay)) !== null) {
        addRef(inlineMatch[2], parseTitleFromDocBlockCodeText(inlineMatch[1]));
    }
    const patterns = [
        DOC_BLOCK_MD_RE,
        DOC_BLOCK_IAL_RE,
        DOC_BLOCK_LABEL_REF_RE,
        DOC_BLOCK_PLAIN_LABEL_REF_RE,
        DOC_BLOCK_HEADING_REF_MD_RE,
    ];
    for (const re of patterns) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(hay)) !== null) {
            addRef(match[1], match[2]);
        }
    }
}

function extractDocRefsFromClipboard(siyuanHTML, textHTML, textPlain) {
    const byId = new Map();
    const addRef = (docId, title) => {
        const id = String(docId || "").trim();
        if (!id) {
            return;
        }
        const nextTitle = cleanTitle(title) || byId.get(id) || "未命名";
        byId.set(id, nextTitle);
    };

    extractDocRefsFromHtmlString(siyuanHTML, addRef);
    extractDocRefsFromHtmlString(textHTML, addRef);
    extractDocRefsFromMarkdown(`${siyuanHTML || ""}\n${textHTML || ""}\n${textPlain || ""}`, addRef);

    return [...byId.entries()].map(([docId, title]) => ({ docId, title }));
}

function buildPasteAsDocRefs(refs) {
    const textPlain = refs.map((ref) => buildDocRefMarkdown(ref.docId, ref.title)).join("\n\n");
    return {
        textPlain,
        textHTML: SIYUAN_CLIPBOARD_ZWSP,
        siyuanHTML: SIYUAN_CLIPBOARD_ZWSP,
    };
}

const SIYUAN_CLIPBOARD_ZWSP = "\u200b";

/**
 * 接管文档块粘贴时，用无害内容替换剪贴板三字段。
 *
 * 思源 paste.ts 仅在 response.textHTML / textPlain / siyuanHTML 为 truthy 时才覆盖原剪贴板；
 * 传空字符串会被忽略，原 siyuanHTML（含旧文档块）仍会走默认粘贴 → id:"" / txerr。
 * 见：https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/util/paste.ts
 */
function resolvePasteNoop(detail) {
    const noop = SIYUAN_CLIPBOARD_ZWSP;
    detail.resolve({
        textHTML: noop,
        textPlain: noop,
        siyuanHTML: noop,
    });
    return {
        textHTML: noop,
        textPlain: noop,
        siyuanHTML: noop,
    };
}

function encodeClipboardBase64(text) {
    const binary = encodeURIComponent(String(text ?? "")).replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return btoa(binary);
}

function decodeClipboardBase64(encoded) {
    try {
        const binary = atob(String(encoded || ""));
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return "";
    }
}

function getTextSiyuanFromTextHTML(html) {
    const source = String(html || "");
    const match = source.match(/<!--data-siyuan='([^']+)'-->/);
    if (!match) {
        return { textSiyuan: "", textHtml: source };
    }
    return {
        textSiyuan: decodeClipboardBase64(match[1]),
        textHtml: source.replace(/<!--data-siyuan='[^']+'-->/g, ""),
    };
}

function embedSiyuanInTextHTML(textHtml, textSiyuan) {
    if (!textSiyuan) {
        return textHtml || "";
    }
    const cleanHtml = String(textHtml || "").replace(/<!--data-siyuan='[^']+'-->/g, "");
    return `<!--data-siyuan='${encodeClipboardBase64(textSiyuan)}'-->${SIYUAN_CLIPBOARD_ZWSP}${cleanHtml}`;
}

function getProtyleFromWysiwyg(wysiwyg) {
    if (!wysiwyg) {
        return null;
    }
    const editor = getAllEditor().find((item) => item?.protyle?.element?.contains?.(wysiwyg));
    return editor?.protyle || null;
}

function findDocBlockElementsInHtml(root) {
    if (!root) {
        return [];
    }
    const found = new Set();
    root.querySelectorAll(`[${ATTR_BLOCK}="1"], [data-${ATTR_BLOCK}="1"]`).forEach((el) => {
        const block = el.closest("[data-node-id]") || el;
        if (block?.getAttribute?.("data-node-id")) {
            found.add(block);
        }
    });
    root.querySelectorAll(`[${ATTR_DOC_ID}], [data-${ATTR_DOC_ID}]`).forEach((el) => {
        const block = el.closest("[data-node-id]");
        if (block && isDocBlockLikeElement(block)) {
            found.add(block);
        }
    });
    root.querySelectorAll('[data-node-id].sub-doc-block, [data-node-id][data-type="NodeHeading"].sub-doc-block, [data-node-id][data-type="NodeParagraph"].sub-doc-block').forEach((block) => {
        if (isDocBlockLikeElement(block)) {
            found.add(block);
        }
    });
    root.querySelectorAll('[data-node-id][data-type="NodeHeading"], [data-node-id][data-type="NodeParagraph"]').forEach((block) => {
        if (isDocBlockLikeElement(block)) {
            found.add(block);
        }
    });
    return [...found];
}

function findTopLevelDocBlockElements(root) {
    return findDocBlockElementsInHtml(root).filter((block) => {
        const parentBlock = block.parentElement?.closest("[data-node-id]");
        return !parentBlock || !root.contains(parentBlock);
    });
}

function mdToBlockDom(protyle, markdown) {
    if (!protyle?.lute || !markdown) {
        return "";
    }
    try {
        return protyle.lute.Md2BlockDOM(String(markdown));
    } catch (error) {
        console.warn(`[${PLUGIN_NAME}]`, "Md2BlockDOM failed", error);
        return "";
    }
}

function blockDomToStdMd(protyle, blockDom) {
    if (!protyle?.lute || !blockDom) {
        return "";
    }
    try {
        return String(protyle.lute.BlockDOM2StdMd(blockDom)).trimEnd();
    } catch (error) {
        console.warn(`[${PLUGIN_NAME}]`, "BlockDOM2StdMd failed", error);
        return "";
    }
}

function blockDomToExportHTML(protyle, blockDom) {
    if (!protyle?.lute || !blockDom) {
        return blockDom || "";
    }
    try {
        return protyle.lute.BlockDOM2HTML(blockDom);
    } catch (error) {
        return blockDom || "";
    }
}

function normalizeClipboardPlain(textPlain) {
    return String(textPlain || "")
        .replace(/\u200b/g, "")
        .replace(/\r\n/g, "\n");
}

function syncClipboardFormatsFromSiyuanHtml(siyuanHTML, protyle) {
    const textPlain = normalizeClipboardPlain(blockDomToStdMd(protyle, siyuanHTML));
    const htmlBody = blockDomToExportHTML(protyle, siyuanHTML);
    return {
        siyuanHTML,
        textHTML: embedSiyuanInTextHTML(htmlBody, siyuanHTML),
        textPlain,
    };
}

function transformDocBlocksInSiyuanHtml(html, protyle) {
    if (!html?.trim() || !protyle?.lute) {
        return { html, changed: false };
    }
    const temp = document.createElement("div");
    temp.innerHTML = html;
    const blocks = findTopLevelDocBlockElements(temp);
    if (blocks.length === 0) {
        return { html, changed: false };
    }
    let changed = false;
    for (const blockEl of blocks) {
        const ref = extractDocRefFromBlockElement(blockEl);
        if (!ref) {
            continue;
        }
        const refDom = mdToBlockDom(protyle, buildDocRefMarkdown(ref.docId, ref.title));
        if (!refDom) {
            continue;
        }
        const holder = document.createElement("div");
        holder.innerHTML = refDom;
        if (holder.firstElementChild) {
            blockEl.replaceWith(holder.firstElementChild);
        } else if (holder.childNodes.length > 0) {
            blockEl.replaceWith(...holder.childNodes);
        } else {
            continue;
        }
        changed = true;
    }
    return { html: temp.innerHTML, changed };
}

function buildMixedSelectionClipboard(selected, protyle) {
    let siyuanHTML = "";
    for (const blockEl of selected) {
        if (isDocBlockLikeElement(blockEl)) {
            const ref = extractDocRefFromBlockElementLoose(blockEl);
            if (ref) {
                siyuanHTML += mdToBlockDom(protyle, buildDocRefMarkdown(ref.docId, ref.title));
            }
            continue;
        }
        siyuanHTML += blockEl.outerHTML;
    }
    return syncClipboardFormatsFromSiyuanHtml(siyuanHTML, protyle);
}

function buildClipboardFromDocRefs(refs, protyle) {
    if (protyle?.lute) {
        const siyuanHTML = refs
            .map((ref) => mdToBlockDom(protyle, buildDocRefMarkdown(ref.docId, ref.title)))
            .filter(Boolean)
            .join("");
        if (siyuanHTML) {
            return syncClipboardFormatsFromSiyuanHtml(siyuanHTML, protyle);
        }
    }
    return buildPasteAsDocRefs(refs);
}

function writeMixedClipboardData(event, payload) {
    event.clipboardData.setData("text/plain", payload.textPlain || "");
    event.clipboardData.setData("text/html", payload.textHTML || "");
    try {
        event.clipboardData.setData("text/siyuan", payload.siyuanHTML || "");
    } catch {
        // ignore unsupported custom mime types
    }
}

function clipboardIsOnlyDocBlocks(siyuanHTML, textHTML, textPlain) {
    if (siyuanHTML?.trim()) {
        const doc = new DOMParser().parseFromString(siyuanHTML, "text/html");
        const blocks = [...doc.body.querySelectorAll("[data-node-id]")].filter((el) => {
            const parentBlock = el.parentElement?.closest("[data-node-id]");
            return !parentBlock || !doc.body.contains(parentBlock);
        });
        if (blocks.length === 0) {
            return findDocBlockElementsInHtml(doc.body).length > 0
                && doc.body.querySelectorAll("[data-node-id]").length === findDocBlockElementsInHtml(doc.body).length;
        }
        return blocks.length > 0 && blocks.every((block) => isDocBlockLikeElement(block));
    }
    if (textHTML?.trim()) {
        const doc = new DOMParser().parseFromString(textHTML, "text/html");
        const docBlocks = findDocBlockElementsInHtml(doc.body);
        if (docBlocks.length === 0) {
            return false;
        }
        const blocks = [...doc.body.querySelectorAll("[data-node-id]")];
        return blocks.length > 0 && blocks.every((block) => isDocBlockLikeElement(block));
    }
    const parts = String(textPlain || "").split(/\n\n/).map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) {
        return false;
    }
    return parts.every((part) => clipboardHasDocBlockMarkup("", "", part));
}

function clipboardHasOnlyDocBlockRefs(siyuanHTML, textHTML, textPlain, refs) {
    if (!refs?.length) {
        return false;
    }
    if (clipboardIsOnlyDocBlocks(siyuanHTML, textHTML, textPlain)) {
        return true;
    }
    if (!clipboardHasDocBlockMarkup(siyuanHTML, textHTML, textPlain)) {
        return false;
    }
    const hay = `${siyuanHTML || ""}${textHTML || ""}${textPlain || ""}`;
    const mdRefCount = (hay.match(/\(\([^(]+?\s+"[^"]*"\)\)/g) || []).length;
    return mdRefCount > 0 && mdRefCount === refs.length;
}

function selectionHasNonDocBlocks(wysiwyg) {
    const selected = getSelectedBlockElements(wysiwyg);
    if (selected.length === 0) {
        return false;
    }
    return selected.some((blockEl) => !isDocBlockLikeElement(blockEl));
}

function getSelectedBlockElements(wysiwyg) {
    if (!wysiwyg) {
        return [];
    }
    const selected = [...wysiwyg.querySelectorAll(".protyle-wysiwyg--select")];
    if (selected.length > 0) {
        return selected;
    }
    const selection = window.getSelection();
    if (!selection?.rangeCount) {
        return [];
    }
    let node = selection.getRangeAt(0).startContainer;
    while (node && node !== wysiwyg) {
        if (node.nodeType === 1 && node.getAttribute?.("data-node-id")) {
            return [node];
        }
        node = node.parentElement;
    }
    return [];
}

function extractDocRefFromBlockElementLoose(blockEl) {
    if (!blockEl) {
        return null;
    }
    const scope = getDocBlockContentScope(blockEl) || blockEl;
    const refEl = scope.querySelector('span[data-type*="block-ref"][data-subtype="d"], span[data-type*="block-ref"][data-type*="d"]')
        || scope.querySelector('span[data-type*="block-ref"]');
    let docId = readDocIdFromElement(blockEl);
    if (!docId && refEl) {
        docId = refEl.getAttribute("data-id");
    }
    if (!docId) {
        return null;
    }
    const codeEl = scope.querySelector('span[data-type="code"]:not([data-type*="block-ref"]), code');
    let title = "未命名";
    if (refEl) {
        title = parseTitleFromDocBlockCodeText(refEl.textContent);
    } else if (codeEl) {
        title = parseTitleFromDocBlockCodeText(codeEl.textContent);
    } else {
        title = parseTitleFromDocBlockCodeText(blockEl.textContent);
    }
    return { docId, title };
}

function isDocBlockLikeElement(blockEl) {
    if (!blockEl) {
        return false;
    }
    if (isPrimaryDocBlockElement(blockEl)) {
        return true;
    }
    if (blockEl.classList?.contains("sub-doc-block") && extractDocRefFromBlockElementLoose(blockEl)) {
        return true;
    }
    const type = blockEl.getAttribute("data-type");
    if (type !== "NodeHeading" && type !== "NodeParagraph") {
        return false;
    }
    const ref = extractDocRefFromBlockElementLoose(blockEl);
    if (!ref) {
        return false;
    }
    const docRefs = blockEl.querySelectorAll('span[data-type*="block-ref"][data-subtype="d"], span[data-type*="block-ref"]');
    return docRefs.length === 1;
}

function extractDocRefFromBlockElement(blockEl) {
    if (!isDocBlockLikeElement(blockEl)) {
        return null;
    }
    return extractDocRefFromBlockElementLoose(blockEl);
}

function extractDocRefsFromSelection(wysiwyg) {
    const refs = [];
    const seen = new Set();
    for (const blockEl of getSelectedBlockElements(wysiwyg)) {
        const ref = extractDocRefFromBlockElement(blockEl);
        if (!ref || seen.has(ref.docId)) {
            continue;
        }
        seen.add(ref.docId);
        refs.push(ref);
    }
    return refs;
}

function writeDocRefsToClipboardData(event, refs, protyle = null) {
    const payload = buildClipboardFromDocRefs(refs, protyle);
    event.clipboardData.setData("text/plain", payload.textPlain || "");
    event.clipboardData.setData("text/html", payload.textHTML || "");
    try {
        event.clipboardData.setData("text/siyuan", payload.siyuanHTML || "");
    } catch {
        // ignore unsupported custom mime types
    }
}

function scheduleRewriteClipboardAsDocRefs(refs) {
    const payload = buildPasteAsDocRefs(refs);
    const write = () => {
        navigator.clipboard?.writeText?.(payload.textPlain)?.catch?.(() => {});
    };
    queueMicrotask(write);
    window.setTimeout(write, 0);
    window.setTimeout(write, 80);
}

function handleCopyCapture(event, plugin = null) {
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "PROTYLE-HTML") {
        return;
    }
    const wysiwyg = event.target?.closest?.(".protyle-wysiwyg");
    if (!wysiwyg) {
        return;
    }
    const selected = getSelectedBlockElements(wysiwyg);
    const refs = extractDocRefsFromSelection(wysiwyg);
    if (refs.length === 0) {
        if (event.type === "copy" || event.type === "cut") {
            clearDocClipboardState();
        }
        return;
    }
    const protyle = getProtyleFromWysiwyg(wysiwyg);
    const onlyDocBlocks = !selectionHasNonDocBlocks(wysiwyg)
        && selected.length > 0
        && selected.every((blockEl) => isDocBlockLikeElement(blockEl));
    const sourceParentDocId = protyle?.block?.rootID
        || protyle?.block?.rootId
        || protyle?.getInstance?.()?.block?.rootID
        || null;
    const sourceBlockId = selected[0]?.getAttribute?.("data-node-id") || null;

    if (event.type === "copy") {
        if (onlyDocBlocks) {
            plugin?.logEvent("user.copy.doc-block", {
                refs: refs.map((ref) => ref.docId),
                sourceParentDocId,
                sourceBlockId,
            });
            if (refs.length === 1) {
                setDocClipboardState({
                    mode: DOC_CLIPBOARD_MODE_COPY,
                    subDocId: refs[0].docId,
                    sourceTitle: refs[0].title,
                    sourceBlockId,
                    sourceParentDocId,
                });
            } else {
                clearDocClipboardState();
            }
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            writeDocRefsToClipboardData(event, refs, protyle);
            console.log(`[${PLUGIN_NAME}]`, "copy as doc ref", refs);
            return;
        }
        plugin?.logEvent("user.copy.mixed-selection", {
            blockCount: selected.length,
            refs: refs.map((ref) => ref.docId),
        });
        clearDocClipboardState();
        if (!protyle?.lute || selected.length === 0) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const payload = buildMixedSelectionClipboard(selected, protyle);
        writeMixedClipboardData(event, payload);
        console.log(`[${PLUGIN_NAME}]`, "copy mixed blocks as siyuan clipboard", { blockCount: selected.length, refs });
        return;
    }

    if (event.type === "cut" && onlyDocBlocks) {
        plugin?.logEvent("user.cut.doc-block", {
            refs: refs.map((ref) => ref.docId),
            sourceParentDocId,
            sourceBlockId,
        });
        if (refs.length === 1) {
            setDocClipboardState({
                mode: DOC_CLIPBOARD_MODE_CUT,
                subDocId: refs[0].docId,
                sourceTitle: refs[0].title,
                sourceBlockId,
                sourceParentDocId,
            });
        } else {
            clearDocClipboardState();
        }
        scheduleRewriteClipboardAsDocRefs(refs);
        console.log(`[${PLUGIN_NAME}]`, "cut clipboard rewrite as doc ref", refs);
        return;
    }
    if (event.type === "cut") {
        plugin?.logEvent("user.cut.non-doc-selection", {
            refs: refs.map((ref) => ref.docId),
        });
        clearDocClipboardState();
    }
}

function clipboardHayHasDocBlockBinding(siyuanHTML, textHTML, textPlain) {
    const hay = `${siyuanHTML || ""}${textHTML || ""}${textPlain || ""}`;
    if (!hay) {
        return false;
    }
    return /data-custom-doc-block|custom-doc-block=["']1["']/.test(hay)
        || /\{:[^}]*custom-doc-block=["']?1["']?/.test(hay);
}

function processPasteContent(siyuanHTML, textHTML, textPlain, protyle) {
    const refs = extractDocRefsFromClipboard(siyuanHTML, textHTML, textPlain);
    if (refs.length > 0 && !clipboardHayHasDocBlockBinding(siyuanHTML, textHTML, textPlain)) {
        return {
            ...buildClipboardFromDocRefs(refs, protyle),
            changed: true,
        };
    }

    if (!clipboardHasDocBlockMarkup(siyuanHTML, textHTML, textPlain)) {
        return { siyuanHTML, textHTML, textPlain, changed: false };
    }

    let effectiveSiyuanHTML = siyuanHTML || "";
    if (!effectiveSiyuanHTML && textHTML) {
        effectiveSiyuanHTML = getTextSiyuanFromTextHTML(textHTML).textSiyuan;
    }

    if (effectiveSiyuanHTML && protyle?.lute) {
        const result = transformDocBlocksInSiyuanHtml(effectiveSiyuanHTML, protyle);
        if (result.changed) {
            return {
                changed: true,
                ...syncClipboardFormatsFromSiyuanHtml(result.html, protyle),
            };
        }
    }

    if (refs.length === 0) {
        return { siyuanHTML, textHTML, textPlain, changed: false };
    }
    if (!clipboardHasOnlyDocBlockRefs(siyuanHTML, textHTML, textPlain, refs)) {
        return { siyuanHTML, textHTML, textPlain, changed: false };
    }
    return {
        ...buildClipboardFromDocRefs(refs, protyle),
        changed: true,
    };
}

function readCustomAttr(el, name) {
    if (!el) {
        return null;
    }
    return el.getAttribute(name) || el.getAttribute(`data-${name}`);
}

function isDocBlockCarrier(el) {
    return readCustomAttr(el, ATTR_BLOCK) === "1";
}

function readDocIdFromElement(blockEl) {
    if (!blockEl) {
        return null;
    }
    const direct = readCustomAttr(blockEl, ATTR_DOC_ID);
    if (direct) {
        return direct;
    }
    const carrier = blockEl.querySelector(`[${ATTR_DOC_ID}], [data-${ATTR_DOC_ID}]`);
    return readCustomAttr(carrier, ATTR_DOC_ID);
}

function isPrimaryDocBlockElement(blockEl) {
    if (!blockEl) {
        return false;
    }
    if (isDocBlockCarrier(blockEl) || blockEl.querySelector(`[${ATTR_BLOCK}="1"], [data-${ATTR_BLOCK}="1"]`)) {
        return !!readDocIdFromElement(blockEl);
    }
    return false;
}

function stripDocBlockCustomAttrs(text) {
    if (!text) {
        return text;
    }
    let out = String(text);
    for (const attr of [ATTR_BLOCK, ATTR_DOC_ID]) {
        out = out.replace(new RegExp(`\\s*${attr}=["'][^"']*["']`, "g"), "");
        out = out.replace(new RegExp(`\\s*data-${attr.replace(/-/g, "\\-")}=["'][^"']*["']`, "g"), "");
    }
    return stripVisibleIal(out);
}

function readNodeProperties(node) {
    if (!node || typeof node !== "object") {
        return null;
    }
    const props = node.Properties || node.properties;
    if (props && typeof props === "object") {
        return props;
    }
    if (node.attrs && typeof node.attrs === "object") {
        return node.attrs;
    }
    if (node[ATTR_BLOCK] != null || node[ATTR_DOC_ID] != null) {
        return node;
    }
    return null;
}

function getDocBlockBindingFromProperties(props) {
    if (!props) {
        return null;
    }
    const blockFlag = props[ATTR_BLOCK] === "1" || props[ATTR_BLOCK] === 1;
    const subDocId = props[ATTR_DOC_ID];
    if (blockFlag && subDocId) {
        return { subDocId: String(subDocId) };
    }
    return null;
}

function forEachOpDataNode(data, visitor) {
    const seen = new Set();
    const walk = (node) => {
        if (!node || typeof node !== "object" || seen.has(node)) {
            return;
        }
        seen.add(node);
        visitor(node);
        const children = node.Children || node.children;
        if (Array.isArray(children)) {
            for (const child of children) {
                walk(child);
            }
        }
    };
    if (Array.isArray(data)) {
        for (const item of data) {
            walk(item);
        }
        return;
    }
    walk(data);
}

/** 从 AST Properties 或 IAL/markdown 字符串读取文档块绑定（双属性缺一不可） */
function getDocBlockBindingFromOpData(data) {
    if (!data) {
        return null;
    }
    if (typeof data === "object") {
        let binding = null;
        forEachOpDataNode(data, (node) => {
            if (binding) {
                return;
            }
            binding = getDocBlockBindingFromProperties(readNodeProperties(node));
        });
        if (binding) {
            return binding;
        }
        return getDocBlockBindingFromProperties(readNodeProperties(data));
    }
    const text = String(data);
    const blockRe = new RegExp(`${ATTR_BLOCK.replace(/-/g, "\\-")}\\s*=\\s*["']?1["']?`);
    const docIdRe = new RegExp(`${ATTR_DOC_ID.replace(/-/g, "\\-")}\\s*=\\s*"([^"]+)"`);
    if (!blockRe.test(text)) {
        return null;
    }
    const docIdMatch = text.match(docIdRe);
    if (docIdMatch?.[1]) {
        return { subDocId: docIdMatch[1] };
    }
    return null;
}

/** 是否为文档块（非纯 block-ref 引用） */
function isDocBlockOpData(data) {
    return !!getDocBlockBindingFromOpData(data)?.subDocId;
}

function extractSubDocIdFromBlockRefOpData(data) {
    if (!data || typeof data !== "object") {
        return null;
    }
    let refId = null;
    forEachOpDataNode(data, (node) => {
        if (refId) {
            return;
        }
        const markType = node.TextMarkType || node.textMarkType;
        if (markType !== "block-ref") {
            return;
        }
        const id = node.TextMarkBlockRefID || node.textMarkBlockRefID;
        if (id) {
            refId = String(id);
        }
    });
    return refId;
}

function extractNewBlockId(response) {
    const data = response?.data;
    if (!data) {
        return null;
    }
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
        if (item?.id) {
            return item.id;
        }
        for (const op of item?.doOperations || []) {
            if (op?.id && (op.action === "insert" || op.action === "append" || op.action === "update")) {
                return op.id;
            }
        }
    }
    return null;
}

function buildDocBlockStyleSelectors(suffix) {
    const parts = [];
    for (let i = 1; i <= 6; i++) {
        parts.push(
            `.protyle-wysiwyg [data-type="NodeHeading"][data-subtype="h${i}"].sub-doc-block${suffix}`,
            `.protyle-wysiwyg [data-type="NodeHeading"][data-subtype="h${i}"][${ATTR_BLOCK}="1"]${suffix}`,
            `.protyle-wysiwyg [data-type="NodeHeading"][data-subtype="h${i}"][data-${ATTR_BLOCK}="1"]${suffix}`,
        );
    }
    parts.push(
        `.protyle-wysiwyg [data-type="NodeParagraph"].sub-doc-block${suffix}`,
        `.protyle-wysiwyg [data-type="NodeParagraph"][${ATTR_BLOCK}="1"]${suffix}`,
        `.protyle-wysiwyg [data-type="NodeParagraph"][data-${ATTR_BLOCK}="1"]${suffix}`,
    );
    return parts.join(",\n");
}

function injectStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        document.head.appendChild(style);
    }
    style.textContent = `
${buildDocBlockStyleSelectors("")} {
    display: block;
    width: 100%;
    margin: .25em 0;
}
${buildDocBlockStyleSelectors(" [contenteditable]")} {
    display: block;
    width: 100%;
    cursor: default;
    user-select: none;
    caret-color: transparent;
}
${buildDocBlockStyleSelectors(" span[data-type~=\"block-ref\"]")} {
    display: inline;
    font: inherit;
    font-weight: inherit;
    font-size: inherit;
    line-height: inherit;
    color: inherit;
    background: none;
    border-radius: 0;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 2px;
    text-decoration-thickness: 1px;
    cursor: pointer;
    user-select: none;
    pointer-events: auto;
}
`;
}

function decorateSubDocBlocks(root = document, plugin = null) {
    const seen = new Set();

    const applyDecoration = (blockEl, docId, styleTarget) => {
        const blockId = blockEl?.getAttribute("data-node-id");
        if (!blockId || !docId || seen.has(blockId)) {
            return;
        }
        seen.add(blockId);
        if (plugin) {
            plugin.rememberBlockSubDoc(blockId, docId);
        }
        blockEl.classList.add("sub-doc-block");
        blockEl.setAttribute("data-sub-doc-block", "1");
        if (!styleTarget.dataset.subDocBound) {
            styleTarget.dataset.subDocBound = "true";
        }
        blockEl.querySelectorAll("div[data-sub-doc-readonly]").forEach((node) => node.removeAttribute("data-sub-doc-readonly"));
    };

    root.querySelectorAll?.(`[${ATTR_DOC_ID}], [data-${ATTR_DOC_ID}]`)?.forEach((element) => {
        if (!isDocBlockCarrier(element)) {
            return;
        }
        const blockEl = element.closest("[data-node-id]");
        const docId = readCustomAttr(element, ATTR_DOC_ID);
        applyDecoration(blockEl, docId, element);
    });

    root.querySelectorAll?.("[data-node-id]")?.forEach((blockEl) => {
        if (!isPrimaryDocBlockElement(blockEl)) {
            return;
        }
        const docId = readDocIdFromElement(blockEl);
        const styleTarget = isDocBlockCarrier(blockEl)
            ? blockEl
            : blockEl.querySelector(`[${ATTR_DOC_ID}], [data-${ATTR_DOC_ID}]`) || blockEl;
        applyDecoration(blockEl, docId, styleTarget);
    });

    if (plugin?.blockToSubDoc?.size) {
        plugin.blockToSubDoc.forEach((docId, blockId) => {
            if (!docId || seen.has(blockId)) {
                return;
            }
            const blockEl = root.matches?.(`[data-node-id="${blockId}"]`)
                ? root
                : root.querySelector?.(`[data-node-id="${blockId}"]`);
            if (blockEl) {
                applyDecoration(blockEl, docId, blockEl);
            }
        });
    }
}

async function queryBlockAttrsFromSql(blockId) {
    if (!blockId) {
        return null;
    }
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `select name, value from attributes where block_id = '${escapeSqlLiteral(blockId)}'`,
    });
    if (response.code !== 0 || !response.data?.length) {
        return null;
    }
    const attrs = {};
    for (const row of response.data) {
        attrs[row.name] = row.value;
    }
    return attrs;
}

function readSubDocIdFromDom(blockId) {
    if (!blockId) {
        return null;
    }
    const blockEl = document.querySelector(`[data-node-id="${blockId}"]`);
    return readDocIdFromElement(blockEl);
}

function isSubDocBlockDom(blockId) {
    if (!blockId) {
        return false;
    }
    const blockEl = document.querySelector(`[data-node-id="${blockId}"]`);
    return isPrimaryDocBlockElement(blockEl);
}

async function getBlockAttrs(blockId, options = {}) {
    if (!blockId) {
        return null;
    }
    if (options.preferSql) {
        const sqlAttrs = await queryBlockAttrsFromSql(blockId);
        if (sqlAttrs) {
            return sqlAttrs;
        }
    }
    if (!options.skipWait && !(await waitForBlockRow(blockId, 3, 50))) {
        return null;
    }
    const response = await fetchSyncPost("/api/attr/getBlockAttrs", { id: blockId });
    if (response.code !== 0) {
        return null;
    }
    return response.data || {};
}

async function setDocBlockAttrs(blockId, docId, extraAttrs = {}, options = {}) {
    if (options.skipWait) {
        if (!(await isBlockRowPresent(blockId))) {
            console.warn(`[${PLUGIN_NAME}]`, "setDocBlockAttrs skip: block not ready", blockId);
            return false;
        }
    } else if (!(await waitForBlockRow(blockId))) {
        console.warn(`[${PLUGIN_NAME}]`, "setDocBlockAttrs skip: block not ready", blockId);
        return false;
    }
    const response = await fetchSyncPost("/api/attr/setBlockAttrs", {
        id: blockId,
        attrs: {
            [ATTR_BLOCK]: "1",
            [ATTR_DOC_ID]: docId,
            ...extraAttrs,
        },
    });
    return response.code === 0;
}

/** 写入双向绑定：块属性 + 子文档反向指针 */
async function writeDocBlockBinding(blockId, subDocId, options = {}) {
    if (!blockId || !subDocId) {
        return false;
    }
    const attrsOk = await setDocBlockAttrs(blockId, subDocId, {}, options);
    if (!attrsOk) {
        return false;
    }
    await setDocBlockIdOnDoc(subDocId, blockId);
    return true;
}

async function setDocBlockIdOnDoc(docId, blockId) {
    if (!docId || !blockId) {
        return;
    }
    await fetchSyncPost("/api/attr/setBlockAttrs", {
        id: docId,
        attrs: {
            [ATTR_DOC_BLOCK_ID]: blockId,
        },
    });
}

async function clearDocBlockIdOnDoc(docId) {
    if (!docId) {
        return;
    }
    await fetchSyncPost("/api/attr/setBlockAttrs", {
        id: docId,
        attrs: {
            [ATTR_DOC_BLOCK_ID]: "",
        },
    });
}

async function getDocBlockIdFromDoc(docId) {
    if (!docId) {
        return null;
    }
    const attrs = await queryBlockAttrsFromSql(docId);
    return attrs?.[ATTR_DOC_BLOCK_ID] || null;
}

/**
 * 解析文档块绑定（权威路径：SQL 双属性）。
 * @param {object} [options]
 * @param {boolean} [options.strict=true] true 时仅认 custom-doc-block=1 + custom-doc-id
 */
async function getSubDocIdFromBlock(blockId, options = {}) {
    if (!blockId) {
        return null;
    }

    const strict = options.strict !== false;
    const binding = await getDocBlockBindingFromBlockId(blockId);
    if (binding?.subDocId) {
        return binding.subDocId;
    }
    if (strict) {
        return null;
    }

    // 非严格模式：仅用于删除恢复；不再做 parent/child 关联块扫描（易误判且极慢）
    const attrs = await queryBlockAttrsFromSql(blockId);
    const looseBinding = getDocBlockBindingFromProperties(attrs);
    return looseBinding?.subDocId || null;
}

async function getBlockRootId(blockId) {
    if (!blockId) {
        return null;
    }
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `select root_id from blocks where id = '${escapeSqlLiteral(blockId)}' limit 1`,
    });
    if (response.code === 0 && response.data?.[0]?.root_id) {
        return response.data[0].root_id;
    }
    return null;
}

async function getLastBlockIdInDoc(docId, excludeBlockIds = []) {
    if (!docId) {
        return null;
    }
    const exclude = new Set((excludeBlockIds || []).filter(Boolean));
    const response = await fetchSyncPost("/api/block/getTailChildBlocks", {
        id: docId,
        n: Math.max(7, exclude.size + 1),
    });
    if (response.code !== 0 || !Array.isArray(response.data)) {
        return null;
    }
    for (const block of response.data) {
        const id = block?.id || block?.ID;
        if (id && !exclude.has(id)) {
            return id;
        }
    }
    return null;
}

async function loadAllSubDocBlockMappings() {
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `
            select a.block_id as id, a.value as sub_doc_id
            from attributes a
            inner join attributes b on b.block_id = a.block_id
            where a.name = '${ATTR_DOC_ID}'
            and b.name = '${ATTR_BLOCK}' and b.value = '1'
        `,
    });
    if (response.code !== 0) {
        return [];
    }
    return response.data || [];
}

async function getDocTitle(docId) {
    const row = await getDocumentRow(docId);
    if (row?.content) {
        return cleanTitle(row.content);
    }
    return "未命名";
}

async function getPrimaryDocBlockId(docId) {
    const fromDoc = await getDocBlockIdFromDoc(docId);
    if (fromDoc) {
        return fromDoc;
    }
    const escapedDocId = escapeSqlLiteral(docId);
    const stmt = `
        select distinct a.block_id as id from attributes a
        where a.name = '${ATTR_DOC_ID}' and a.value = '${escapedDocId}'
        and exists (
            select 1 from attributes b
            where b.block_id = a.block_id
            and b.name = '${ATTR_BLOCK}' and b.value = '1'
        )
        limit 1
    `;
    const response = await fetchSyncPost("/api/query/sql", { stmt });
    return response.data?.[0]?.id || null;
}

async function findSubDocBlockIds(subDocId) {
    const primaryId = await getPrimaryDocBlockId(subDocId);
    return primaryId ? [primaryId] : [];
}

async function listDocBlockIdsForSubDoc(subDocId) {
    if (!subDocId) {
        return [];
    }
    const escaped = escapeSqlLiteral(subDocId);
    const stmt = `
        select distinct a.block_id as id
        from attributes a
        inner join attributes b on b.block_id = a.block_id
        where a.name = '${ATTR_DOC_ID}' and a.value = '${escaped}'
        and b.name = '${ATTR_BLOCK}' and b.value = '1'
    `;
    const response = await fetchSyncPost("/api/query/sql", { stmt });
    if (response.code !== 0) {
        return [];
    }
    return (response.data || []).map((row) => row.id).filter(Boolean);
}

async function hasActiveDocBlockBinding(subDocId, blockIdHint = null) {
    if (!subDocId) {
        return false;
    }
    if (blockIdHint) {
        const attrs = await queryBlockAttrsFromSql(blockIdHint);
        if (attrs?.[ATTR_BLOCK] === "1" && attrs?.[ATTR_DOC_ID] === subDocId) {
            return true;
        }
    }
    const blockIds = await listDocBlockIdsForSubDoc(subDocId);
    return blockIds.length > 0;
}

/** 删除后该 blockId 是否仍以文档块形式存在（用于拦截迟到的 delete 回包，不用于 flush 进回收站） */
async function isDeletedDocBlockStillPresent(blockId, subDocId) {
    if (!blockId || !subDocId || !(await isBlockRowPresent(blockId))) {
        return false;
    }
    const attrs = await queryBlockAttrsFromSql(blockId);
    return attrs?.[ATTR_BLOCK] === "1" && attrs?.[ATTR_DOC_ID] === subDocId;
}

/** 仅当被删的是文档块（双属性）时返回绑定的子文档 id；引用块删除返回 null */
async function getDocBlockBindingFromBlockId(blockId) {
    if (!blockId) {
        return null;
    }
    const attrs = await queryBlockAttrsFromSql(blockId);
    return getDocBlockBindingFromProperties(attrs);
}

async function resolveSubDocIdForDeletedBlock(blockId, opData) {
    if (!blockId) {
        return null;
    }
    const fromOp = getDocBlockBindingFromOpData(opData);
    if (fromOp?.subDocId) {
        return fromOp.subDocId;
    }
    const fromSql = await getDocBlockBindingFromBlockId(blockId);
    return fromSql?.subDocId || null;
}

function normalizeWsTransactions(data) {
    if (!data) {
        return [];
    }
    if (Array.isArray(data)) {
        return data;
    }
    if (Array.isArray(data.transactions)) {
        return data.transactions;
    }
    return [data];
}

function summarizeTransactionOps(transactions) {
    const summary = [];
    for (const tx of normalizeWsTransactions(transactions)) {
        for (const op of tx.doOperations || tx.DoOperations || []) {
            const blockId = getOpBlockId(op);
            summary.push({
                action: getOpAction(op),
                blockId,
                parentID: getOpParentId(op),
                dataId: op?.data?.id || null,
                hasEmptyId: !blockId,
            });
        }
    }
    return summary;
}

function getOpAction(op) {
    return op?.action || op?.Action || "";
}

function getOpBlockId(op) {
    return op?.id || op?.ID || null;
}

function getOpParentId(op) {
    return op?.parentID || op?.ParentID || null;
}

function markdownLooksLikeSubDocBlock(text) {
    return markdownLooksLikeDocBlock(text);
}

function extractSubDocIdFromMarkdown(text) {
    const s = String(text || "");
    const attrMatch = s.match(new RegExp(`${ATTR_DOC_ID.replace(/-/g, "\\-")}\\s*=\\s*"([^"]+)"`));
    if (attrMatch?.[1]) {
        return attrMatch[1];
    }
    if (!new RegExp(`(?:${DOC_BLOCK_HEADING_MD})?\\*\\*${DOC_BLOCK_LABELS}\\*\\*`).test(s) && !markdownLooksLikeDocBlock(s)) {
        return null;
    }
    const refMatch = s.match(/\(\(\s*([^\s(]+)\s+"[^"]*"\s*\)\)/);
    return refMatch?.[1] || null;
}

function extractTitleFromOpData(data) {
    if (!data) {
        return null;
    }
    const s = typeof data === "string" ? data : JSON.stringify(data);
    const refMatch = s.match(/\(\(\s*[^(\s]+\s+"((?:\\.|[^"\\])*)"\s*\)\)/);
    if (!refMatch?.[1]) {
        return null;
    }
    return cleanTitle(refMatch[1].replace(/\\(.)/g, "$1"));
}

function extractSubDocIdFromHtml(html) {
    const text = String(html || "");
    const patterns = [
        new RegExp(`${ATTR_DOC_ID}\\s*=\\s*"([^"]+)"`),
        new RegExp(`data-${ATTR_DOC_ID.replace(/-/g, "\\-")}\\s*=\\s*"([^"]+)"`),
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
            return match[1];
        }
    }
    return null;
}

function extractSubDocIdFromOpData(data) {
    if (!data) {
        return null;
    }
    const docBinding = getDocBlockBindingFromOpData(data);
    if (docBinding?.subDocId) {
        return docBinding.subDocId;
    }
    if (typeof data === "string") {
        return extractSubDocIdFromMarkdown(data) || extractSubDocIdFromHtml(data);
    }
    return extractSubDocIdFromBlockRefOpData(data);
}

async function resolveTargetDocIdForOp(op, blockId, plugin) {
    const parentId = getOpParentId(op);
    if (parentId) {
        const rootId = await getBlockRootId(parentId);
        if (rootId) {
            return rootId;
        }
    }
    if (blockId) {
        return getBlockRootId(blockId);
    }
    return null;
}

/** 从 op 数据或内存缓存解析 subDocId，避免对每个 transaction op 打 SQL */
function resolveSubDocIdFromOpOrCache(op, blockId, plugin) {
    const fromOp = extractSubDocIdFromOpData(op?.data || op?.Data);
    if (fromOp) {
        return fromOp;
    }
    if (blockId && plugin?.blockToSubDoc?.has(blockId)) {
        return plugin.blockToSubDoc.get(blockId);
    }
    return null;
}

async function analyzeTransactionSubDocOps(tx, plugin) {
    const ops = tx.doOperations || tx.DoOperations || [];
    const deletedSubDocIds = new Map();
    const relocated = new Map();

    for (const op of ops) {
        if (getOpAction(op) !== "delete" || !getOpBlockId(op)) {
            continue;
        }
        const blockId = getOpBlockId(op);
        const subDocId = await resolveSubDocIdForDeletedBlock(blockId, op.data || op.Data);
        if (subDocId) {
            deletedSubDocIds.set(subDocId, blockId);
        }
    }

    for (const op of ops) {
        const action = getOpAction(op);
        const blockId = getOpBlockId(op);
        if (!blockId || action === "delete") {
            continue;
        }

        let subDocId = resolveSubDocIdFromOpOrCache(op, blockId, plugin);
        if (!subDocId && (action === "move" || isDocBlockOpData(op.data || op?.Data))) {
            const binding = await getDocBlockBindingFromBlockId(blockId);
            subDocId = binding?.subDocId || null;
            if (subDocId) {
                plugin.rememberBlockSubDoc(blockId, subDocId);
            }
        }
        if (!subDocId) {
            continue;
        }

        const targetDocId = await resolveTargetDocIdForOp(op, blockId, plugin);
        if (!targetDocId || targetDocId === subDocId) {
            continue;
        }

        if (action === "move" || action === "insert" || action === "append" || action === "update") {
            if (deletedSubDocIds.has(subDocId)) {
                relocated.set(subDocId, targetDocId);
            }
        }

        if (action === "setAttrs" || action === "updateAttrs") {
            const attrs = op.data?.attrs || op.retData?.attrs || op.data;
            if (attrs?.[ATTR_BLOCK] === "1" || attrs?.[ATTR_DOC_ID]) {
                if (deletedSubDocIds.has(subDocId)) {
                    relocated.set(subDocId, targetDocId);
                }
            }
        }
    }

    return { deletedSubDocIds, relocated };
}

async function collectDeletedDocBlockIds(transactions, plugin) {
    const items = [];
    const seen = new Set();
    for (const tx of transactions || []) {
        for (const op of tx.doOperations || tx.DoOperations || []) {
            if (getOpAction(op) !== "delete") {
                continue;
            }
            const blockId = getOpBlockId(op);
            if (!blockId || seen.has(blockId)) {
                continue;
            }
            const subDocId = await resolveSubDocIdForDeletedBlock(blockId, op.data || op.Data);
            if (!subDocId) {
                continue;
            }
            seen.add(blockId);
            items.push({ blockId, subDocId });
        }
    }
    return items;
}

async function prepareApiContext(url, body, plugin) {
    const ctx = {
        treeDocDeletes: [],
        deletedDocBlockIds: [],
        rename: null,
        create: null,
        moveDocs: null,
    };

    if (!body) {
        return ctx;
    }

    if (url.includes("/api/filetree/createDocWithMd") || url.includes("/api/filetree/createDoc")) {
        ctx.create = {
            body,
            source: url.includes("createDocWithMd") ? "createDocWithMd" : "createDoc",
        };
        return ctx;
    }

    if (url.includes("/api/block/deleteBlock") && body.id) {
        const subDocId = await plugin.resolveSubDocIdForBlock(body.id);
        if (subDocId) {
            ctx.deletedDocBlockIds.push({ blockId: body.id, subDocId });
        }
    }

    if (url.includes("/api/transactions") && body.transactions) {
        ctx.deletedDocBlockIds.push(...await collectDeletedDocBlockIds(body.transactions, plugin));
    }

    if (url.includes("/api/filetree/removeDocByID") && body.id) {
        const blockId = await getPrimaryDocBlockId(body.id);
        ctx.treeDocDeletes.push({ docId: body.id, blockId: blockId || null });
    }

    if (url.includes("/api/filetree/removeDoc") && body.path) {
        const docId = docIdFromStoragePath(body.path);
        if (docId) {
            const blockId = await getPrimaryDocBlockId(docId);
            ctx.treeDocDeletes.push({ docId, blockId: blockId || null });
        }
    }

    if (url.includes("/api/filetree/removeDocs") && Array.isArray(body.paths)) {
        for (const path of body.paths) {
            const docId = docIdFromStoragePath(path);
            if (!docId) {
                continue;
            }
            const blockId = await getPrimaryDocBlockId(docId);
            ctx.treeDocDeletes.push({ docId, blockId: blockId || null });
        }
    }

    if (url.includes("/api/filetree/renameDocByID") && body.id && body.title) {
        ctx.rename = { docId: body.id, title: body.title };
    }

    if (url.includes("/api/filetree/renameDoc") && body.path && body.title) {
        ctx.rename = { docId: docIdFromStoragePath(body.path), title: body.title };
    }

    if (url.includes("/api/filetree/moveDocsByID") && Array.isArray(body.fromIDs) && body.toID) {
        ctx.moveDocs = {
            fromIDs: body.fromIDs,
            toID: body.toID,
            byId: true,
        };
    }

    if (url.includes("/api/filetree/moveDocs") && Array.isArray(body.fromPaths) && body.toPath != null) {
        ctx.moveDocs = {
            fromPaths: body.fromPaths,
            toNotebook: body.toNotebook,
            toPath: body.toPath,
            byId: false,
        };
    }

    return ctx;
}

function normalizeDocIdFromPathSegment(segment) {
    if (!segment) {
        return null;
    }
    return String(segment).replace(/\.sy$/i, "").trim() || null;
}

function docIdFromFromPathEntry(entry) {
    if (!entry) {
        return null;
    }
    if (typeof entry === "string") {
        return docIdFromStoragePath(entry);
    }
    if (typeof entry === "object" && entry.path) {
        return docIdFromStoragePath(entry.path);
    }
    return null;
}

function buildMoveEventSignature(moveInfo) {
    if (!moveInfo) {
        return null;
    }
    if (moveInfo.byId && Array.isArray(moveInfo.fromIDs)) {
        const from = [...moveInfo.fromIDs].filter(Boolean).map(String).sort().join(",");
        const to = String(moveInfo.toID || "");
        if (!from || !to) {
            return null;
        }
        return `id:${from}->${to}`;
    }
    if (Array.isArray(moveInfo.fromPaths)) {
        const fromIds = moveInfo.fromPaths
            .map((entry) => docIdFromFromPathEntry(entry))
            .filter(Boolean)
            .map(String)
            .sort()
            .join(",");
        const toPath = String(moveInfo.toPath ?? "");
        const toNotebook = String(moveInfo.toNotebook ?? "");
        if (!fromIds || (!toPath && !toNotebook)) {
            return null;
        }
        return `path:${fromIds}->${toNotebook}:${toPath}`;
    }
    return null;
}

function resolveTargetFromMoveToPath(toPath) {
    if (toPath == null || toPath === "") {
        return null;
    }
    const normalized = String(toPath).replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalized || normalized === "/") {
        return null;
    }
    const parts = normalized.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length === 0) {
        return null;
    }
    return normalizeDocIdFromPathSegment(parts[parts.length - 1]);
}

function isSelfDocTreeMove(subDocId, moveInfo) {
    if (!subDocId || !moveInfo) {
        return false;
    }
    if (moveInfo.byId && moveInfo.toID === subDocId) {
        return true;
    }
    if (moveInfo.toPath && resolveTargetFromMoveToPath(moveInfo.toPath) === subDocId) {
        return true;
    }
    if (moveInfo.byId && Array.isArray(moveInfo.fromIDs) && moveInfo.toID) {
        const movingSelf = moveInfo.fromIDs.includes(subDocId) && moveInfo.toID === subDocId;
        if (movingSelf) {
            return true;
        }
    }
    return false;
}

async function areDocBlocksInDoc(subDocId, docId) {
    const blockIds = await findSubDocBlockIds(subDocId);
    if (blockIds.length === 0 || !docId) {
        return false;
    }
    for (const blockId of blockIds) {
        const rootId = await getBlockRootId(blockId);
        if (rootId !== docId) {
            return false;
        }
    }
    return true;
}

async function resolveMoveTargetParentDocId(moveInfo, subDocId, plugin) {
    const trashNotebook = await plugin.resolveTrashNotebook();

    const normalizeTargetDocId = async (docId) => {
        const id = normalizeDocIdFromPathSegment(docId);
        if (!id) {
            return null;
        }
        if (trashNotebook && id === trashNotebook.id) {
            return null;
        }
        if (await getDocumentRow(id)) {
            return id;
        }
        return null;
    };

    if (moveInfo.byId && moveInfo.toID) {
        const hint = await normalizeTargetDocId(moveInfo.toID);
        if (hint) {
            return hint;
        }
    }
    if (moveInfo.toPath) {
        const hint = await normalizeTargetDocId(resolveTargetFromMoveToPath(moveInfo.toPath));
        if (hint) {
            return hint;
        }
    }

    await flushSqlTransaction();
    for (let i = 0; i < 3; i++) {
        const sqlParent = await normalizeTargetDocId(await resolveParentDocIdFromSql(subDocId));
        if (sqlParent) {
            return sqlParent;
        }
        if (i < 2) {
            await sleep(40);
        }
    }

    return null;
}

function extractDocIdFromListDocsEntry(entry) {
    if (!entry) {
        return null;
    }
    if (typeof entry.id === "string") {
        return entry.id;
    }
    if (typeof entry.ID === "string") {
        return entry.ID;
    }
    const p = entry.path || entry.Path;
    if (typeof p === "string" && p.endsWith(".sy")) {
        return docIdFromStoragePath(p);
    }
    return null;
}

async function listChildDocIdsByParentFromTree(parentDocId) {
    if (!parentDocId) {
        return [];
    }
    const pathInfo = await getPathInfoByDocId(parentDocId);
    if (!pathInfo?.notebook || !pathInfo?.path) {
        return [];
    }
    const listPath = String(pathInfo.path).replace(/\\/g, "/").replace(/\.sy$/i, "");
    const response = await fetchSyncPost("/api/filetree/listDocsByPath", {
        notebook: pathInfo.notebook,
        path: listPath,
        maxListCount: 0,
        showHidden: true,
    });
    if (response.code !== 0 || !Array.isArray(response.data?.files)) {
        return [];
    }
    return response.data.files
        .map((entry) => extractDocIdFromListDocsEntry(entry))
        .filter((id) => !!id);
}

async function listDocBlockSubDocOrderInParent(parentDocId) {
    if (!parentDocId) {
        return [];
    }
    const escaped = escapeSqlLiteral(parentDocId);
    const stmtWithSort = `
        select a.value as sub_doc_id
        from attributes a
        inner join attributes b on b.block_id = a.block_id
        inner join blocks bl on bl.id = a.block_id
        where a.name = '${ATTR_DOC_ID}'
          and b.name = '${ATTR_BLOCK}' and b.value = '1'
          and bl.root_id = '${escaped}'
        order by bl.sort asc, bl.id asc
    `;
    let response = await fetchSyncPost("/api/query/sql", { stmt: stmtWithSort });
    if (response.code !== 0) {
        const stmtFallback = `
            select a.value as sub_doc_id
            from attributes a
            inner join attributes b on b.block_id = a.block_id
            inner join blocks bl on bl.id = a.block_id
            where a.name = '${ATTR_DOC_ID}'
              and b.name = '${ATTR_BLOCK}' and b.value = '1'
              and bl.root_id = '${escaped}'
            order by bl.created asc, bl.id asc
        `;
        response = await fetchSyncPost("/api/query/sql", { stmt: stmtFallback });
    }
    if (response.code !== 0 || !Array.isArray(response.data)) {
        return [];
    }
    return response.data
        .map((row) => row.sub_doc_id)
        .filter((id) => !!id);
}

async function applyApiContext(ctx, plugin, source) {
    if (!ctx) {
        return;
    }
    plugin?.logEvent?.("api-context.apply.start", {
        source,
        treeDocDeletes: ctx.treeDocDeletes?.length || 0,
        deletedDocBlockIds: ctx.deletedDocBlockIds?.length || 0,
        hasRename: !!ctx.rename,
        hasMoveDocs: !!ctx.moveDocs,
    });

    for (const { docId, blockId } of ctx.treeDocDeletes) {
        await plugin.onSubDocRemovedFromTree(docId, blockId, source);
    }

    if (ctx.deletedDocBlockIds.length > 0) {
        await fetchSyncPost("/api/sqlite/flushTransaction", {});
        for (const { blockId, subDocId } of ctx.deletedDocBlockIds) {
            if (!subDocId) {
                continue;
            }
            if (await isDeletedDocBlockStillPresent(blockId, subDocId)) {
                console.log(`[${PLUGIN_NAME}]`, `applyApiContext skip stale delete(${source})`, { blockId, subDocId });
                plugin?.logEvent?.("api-context.delete.skip-stale", { source, blockId, subDocId });
                continue;
            }
            if (!(await plugin.isCanonicalOwnerBlock(subDocId, blockId))) {
                plugin.forgetBlockSubDoc(blockId);
                plugin?.logEvent?.("api-context.delete.skip-non-canonical", { source, blockId, subDocId });
                continue;
            }
            plugin.scheduleDocMove(subDocId, "trash", { blockId, source: `${source}-delete-block` });
            plugin.forgetBlockSubDoc(blockId);
            plugin?.logEvent?.("api-context.delete.schedule-trash", { source, blockId, subDocId });
        }
    }

    if (ctx.rename?.docId && ctx.rename?.title) {
        await plugin.syncSubDocBlockTitle(ctx.rename.docId, ctx.rename.title, source);
    }

    if (ctx.moveDocs) {
        await plugin.handleDocMove(ctx.moveDocs, source);
    }
    plugin?.logEvent?.("api-context.apply.done", { source });
}

function shouldApplyApiContext(url, ctx) {
    if (!ctx) {
        return false;
    }
    return !!(
        ctx.treeDocDeletes.length
        || ctx.deletedDocBlockIds.length
        || ctx.rename
        || ctx.moveDocs
    );
}

module.exports = class SubDocBlockPlugin extends Plugin {
    wsHandler = null;
    protyleLoadHandler = null;
    protyleChangeHandler = null;
    pasteHandler = null;
    copyCaptureHandler = null;
    originalFetch = null;
    trashNotebookId = null;
    trashNotebookEnsurePromise = null;
    docMovePending = new Map();
    recentCreateKeys = new Map();
    recentDocMoveKeys = new Map();
    recentMoveEventKeys = new Map();
    recentSyncKeys = new Map();
    blockToSubDoc = new Map();
    subDocSyncChains = new Map();
    parentSyncChains = new Map();
    parentReconcileTimers = new Map();
    cacheRefreshTimer = null;
    loggerReady = false;
    logSessionId = null;
    logFilePath = null;
    logWriteQueue = Promise.resolve();
    originalConsoleMethods = null;
    creatingSubDocForParent = new Set();
    insertingSubDocBlocks = new Set();
    bindSubDocBlockPromises = new Map();
    syncingDeleteBlockForDoc = new Set();
    syncingTrashDocForBlock = new Set();
    trashingSubDocIds = new Set();
    movingSubDocIds = new Set();
    movingBlocksForDoc = new Set();
    pendingBlockCreates = new Set();
    pendingTitleSync = new Map();
    titleSyncTimers = new Map();
    lastSyncedBlockTitles = new Map();
    pendingTriggerBind = null;
    recentBoundSubDocs = new Map();
    repairDocBlockTimers = new Map();
    repairingDocBlocks = new Set();
    pluginInitiatedSubDocs = new Set();
    slashInProgressForParent = null;
    config = { ...DEFAULT_CONFIG };
    configReady = null;
    setting = null;
    topBarEntry = null;
    clearingTrash = false;

    initSessionLogger() {
        if (!nodeFs || !nodePath) {
            this.loggerReady = false;
            return;
        }
        try {
            nodeFs.mkdirSync(PLUGIN_LOG_DIR, { recursive: true });
            const now = new Date();
            const pad = (n) => String(n).padStart(2, "0");
            const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            const session = `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
            this.logSessionId = session;
            this.logFilePath = nodePath.join(PLUGIN_LOG_DIR, `${PLUGIN_NAME}-${session}.jsonl`);
            nodeFs.writeFileSync(this.logFilePath, "", "utf8");
            nodeFs.writeFileSync(nodePath.join(PLUGIN_LOG_DIR, "latest.txt"), `${this.logFilePath}\n`, "utf8");
            this.loggerReady = true;
            this.logEvent("session.start", {
                session: this.logSessionId,
                file: this.logFilePath,
            });
        } catch (error) {
            this.loggerReady = false;
            console.warn(`[${PLUGIN_NAME}]`, "initSessionLogger failed", error);
            showMessage(`[${PLUGIN_NAME}] 日志初始化失败，无法写入 ${PLUGIN_LOG_DIR}`);
        }
    }

    logEvent(event, payload = {}) {
        if (!this.loggerReady || !this.logFilePath || !nodeFs) {
            return;
        }
        const entry = {
            ts: new Date().toISOString(),
            session: this.logSessionId,
            event,
            payload: safeSerialize(payload),
        };
        const line = `${JSON.stringify(entry)}\n`;
        this.logWriteQueue = this.logWriteQueue
            .then(() => nodeFs.promises.appendFile(this.logFilePath, line, "utf8"))
            .catch(() => {});
    }

    installConsoleMirror() {
        if (this.originalConsoleMethods || !this.loggerReady) {
            return;
        }
        this.originalConsoleMethods = {
            log: console.log.bind(console),
            warn: console.warn.bind(console),
            error: console.error.bind(console),
        };
        const plugin = this;
        const mirror = (level, args) => {
            const original = plugin.originalConsoleMethods?.[level];
            if (original) {
                original(...args);
            }
            try {
                const text = args.map((item) => (typeof item === "string" ? item : JSON.stringify(safeSerialize(item)))).join(" ");
                if (text.includes(PLUGIN_NAME) || text.includes("reconcile")) {
                    plugin.logEvent(`console.${level}`, { text });
                }
            } catch {
                // ignore mirror serialize error
            }
        };
        console.log = (...args) => mirror("log", args);
        console.warn = (...args) => mirror("warn", args);
        console.error = (...args) => mirror("error", args);
    }

    uninstallConsoleMirror() {
        if (!this.originalConsoleMethods) {
            return;
        }
        console.log = this.originalConsoleMethods.log;
        console.warn = this.originalConsoleMethods.warn;
        console.error = this.originalConsoleMethods.error;
        this.originalConsoleMethods = null;
    }

    onload() {
        this.initSessionLogger();
        this.installConsoleMirror();
        this.logEvent("plugin.onload.start");
        console.log(`loading ${PLUGIN_NAME}`);
        injectStyles();
        this.configReady = this.loadPluginConfig().catch((error) => {
            console.warn(`[${PLUGIN_NAME}]`, "loadPluginConfig failed", error);
            this.applyPluginConfig(null);
        });
        this.initSettingPanel();
        this.registerTopBarEntry();
        this.addCommand({
            langKey: "openSubDocBlockSetting",
            hotkey: "",
            callback: () => {
                this.openSetting();
            },
        });
        this.patchFetch();
        this.registerProtyleSlash();

        this.wsHandler = (event) => {
            this.handleWsMain(event?.detail ?? event).catch((error) => {
                console.warn(`[${PLUGIN_NAME}]`, "handleWsMain failed", error);
            });
        };
        this.eventBus.on("ws-main", this.wsHandler);

        this.protyleLoadHandler = (event) => {
            decorateSubDocBlocks(document, this);
            document.querySelectorAll(".protyle-wysiwyg [data-sub-doc-block='1'], .protyle-wysiwyg .sub-doc-block[data-node-id]").forEach((blockEl) => {
                const blockId = blockEl.getAttribute("data-node-id");
                const subDocId = readDocIdFromElement(blockEl) || this.blockToSubDoc.get(blockId);
                if (blockId && subDocId && docBlockPresentationIsCorrupted(blockEl)) {
                    this.scheduleRepairDocBlock(blockId, subDocId, "protyle-load");
                }
            });
            this.scheduleRefreshBlockSubDocCache("protyle-load");
        };
        this.eventBus.on("loaded-protyle-dynamic", this.protyleLoadHandler);
        this.eventBus.on("loaded-protyle-static", this.protyleLoadHandler);

        scheduleBindFileTreeClick(this);

        this.protyleChangeHandler = (event) => {
            this.handleProtyleChange(event?.detail).catch((error) => {
                console.warn(`[${PLUGIN_NAME}]`, "handleProtyleChange failed", error);
            });
        };
        this.eventBus.on("protyle-change", this.protyleChangeHandler);

        this.docBlockKeydownHandler = (event) => {
            try {
                handleDocBlockEditorKeydown(event);
            } catch (error) {
                console.warn(`[${PLUGIN_NAME}]`, "handleDocBlockEditorKeydown failed", error);
            }
        };
        document.addEventListener("keydown", this.docBlockKeydownHandler, true);

        this.pasteHandler = (event) => {
            try {
                this.handlePasteEvent(event);
            } catch (error) {
                console.warn(`[${PLUGIN_NAME}]`, "handlePasteEvent failed", error);
            }
        };
        this.eventBus.on("paste", this.pasteHandler);

        this.copyCaptureHandler = (event) => {
            try {
                handleCopyCapture(event, this);
            } catch (error) {
                console.warn(`[${PLUGIN_NAME}]`, "handleCopyCapture failed", error);
            }
        };
        document.addEventListener("copy", this.copyCaptureHandler, true);
        document.addEventListener("cut", this.copyCaptureHandler, true);
        this.logEvent("plugin.onload.ready");
    }

    async resolvePasteTargetContext(detail) {
        const protyle = detail?.protyle || getActiveProtyleFromEditors();
        const { rootDocId, blockId } = await resolveSlashProtyleContext(protyle, null);
        const afterBlockId = (blockId && blockId !== rootDocId)
            ? blockId
            : resolveCursorBlockId(protyle);
        return {
            targetParentDocId: rootDocId || null,
            triggerBlockId: afterBlockId || null,
        };
    }

    promoteCutClipboardToCopy(state, source) {
        if (!state?.subDocId) {
            return;
        }
        setDocClipboardState({
            ...state,
            mode: DOC_CLIPBOARD_MODE_COPY,
            sourceTitle: state.sourceTitle || "未命名",
            sourceBlockId: null,
            sourceParentDocId: state.sourceParentDocId || null,
            source,
        });
    }

    async resolveClipboardPasteStrategy(state) {
        const sourceSubDocId = state?.subDocId;
        if (!sourceSubDocId) {
            return { strategy: "duplicate", reason: "missing-source" };
        }
        if (!(await isDocumentPresent(sourceSubDocId))) {
            return { strategy: "invalid", reason: "source-doc-missing" };
        }
        if (state.mode === DOC_CLIPBOARD_MODE_COPY) {
            return { strategy: "duplicate", reason: "copy-mode" };
        }
        if (state.mode !== DOC_CLIPBOARD_MODE_CUT) {
            return { strategy: "duplicate", reason: "unknown-mode" };
        }

        const existingBlocks = await findSubDocBlockIds(sourceSubDocId);
        if (existingBlocks.length > 0) {
            return { strategy: "duplicate", reason: "owner-block-exists", existingBlocks };
        }
        if (!(await this.isSubDocInTrash(sourceSubDocId))) {
            return { strategy: "duplicate", reason: "doc-not-in-trash" };
        }
        if (state.sourceBlockId && await isBlockRowPresent(state.sourceBlockId)) {
            return { strategy: "duplicate", reason: "source-block-restored" };
        }
        const canonicalBlockId = await getDocBlockIdFromDoc(sourceSubDocId);
        if (canonicalBlockId && await isBlockRowPresent(canonicalBlockId)) {
            return { strategy: "duplicate", reason: "canonical-block-exists", canonicalBlockId };
        }
        return { strategy: "reuse", reason: "cut-active-in-trash" };
    }

    async isCutClipboardStillValid(state) {
        const { strategy } = await this.resolveClipboardPasteStrategy(state);
        return strategy === "reuse";
    }

    async createCopiedSubDocForPaste(sourceSubDocId, targetParentDocId, sourceTitle) {
        const copyTitle = resolvePasteDocTitle(sourceTitle || await getDocTitle(sourceSubDocId));
        const pathInfo = await getPathInfoByDocId(targetParentDocId);
        const notebook = pathInfo?.notebook;
        this.logEvent("copy-subdoc.start", {
            sourceSubDocId,
            targetParentDocId,
            copyTitle,
            notebook: notebook || null,
        });
        const reservedSubDocId = generateNodeId();
        this.pluginInitiatedSubDocs.add(reservedSubDocId);
        this.markRecentCreate(targetParentDocId, reservedSubDocId);
        // createDoc 会广播 ws-create；标记为插件发起，避免 onSubDocCreated 再绑一次块。
        this.creatingSubDocForParent.add(targetParentDocId);
        try {
            const markdownResponse = await fetchSyncPost("/api/export/exportMdContent", {
                id: sourceSubDocId,
                addTitle: false,
            });
            const markdown = markdownResponse.code === 0 && typeof markdownResponse.data?.content === "string"
                ? markdownResponse.data.content
                : "";

            if (notebook && pathInfo?.path) {
                const newPath = buildChildStoragePath(pathInfo.path, reservedSubDocId);
                const response = await fetchSyncPost("/api/filetree/createDoc", {
                    notebook,
                    path: newPath,
                    title: copyTitle,
                    md: markdown,
                });
                this.logEvent("copy-subdoc.create-doc-response", {
                    sourceSubDocId,
                    targetParentDocId,
                    copyTitle,
                    path: newPath,
                    reservedSubDocId,
                    code: response.code,
                    msg: response.msg,
                });
                if (response.code === 0) {
                    const createdId = typeof response.data === "string" ? response.data : response.data?.id;
                    const subDocId = createdId || reservedSubDocId;
                    this.pluginInitiatedSubDocs.add(subDocId);
                    this.logEvent("copy-subdoc.done", {
                        sourceSubDocId,
                        newSubDocId: subDocId,
                        copyTitle,
                        mode: "createDoc-returned-id",
                    });
                    return { subDocId, title: copyTitle };
                }
                console.warn(`[${PLUGIN_NAME}]`, "createCopiedSubDocForPaste createDoc failed", response);
            }

            const fallbackId = await this.createSubDocUnderParent(targetParentDocId, copyTitle, reservedSubDocId);
            if (!fallbackId) {
                this.logEvent("copy-subdoc.failed", {
                    sourceSubDocId,
                    targetParentDocId,
                    copyTitle,
                    mode: "fallback-create-subdoc-under-parent",
                });
                return null;
            }
            this.pluginInitiatedSubDocs.add(fallbackId);
            this.logEvent("copy-subdoc.done", {
                sourceSubDocId,
                newSubDocId: fallbackId,
                copyTitle,
                mode: "fallback-create-subdoc-under-parent",
            });
            return { subDocId: fallbackId, title: copyTitle };
        } finally {
            window.setTimeout(() => {
                this.creatingSubDocForParent.delete(targetParentDocId);
            }, 5000);
        }
    }

    async tryHandleDocClipboardPaste(event, detail, state) {
        if (!state?.subDocId || !state?.mode) {
            return false;
        }
        this.logEvent("user.paste.doc-clipboard.detected", {
            mode: state.mode,
            subDocId: state.subDocId,
            sourceParentDocId: state.sourceParentDocId || null,
            sourceBlockId: state.sourceBlockId || null,
        });
        if (!(await isDocumentPresent(state.subDocId))) {
            clearDocClipboardState();
            this.logEvent("user.paste.doc-clipboard.invalid-doc-missing", { subDocId: state.subDocId });
            return false;
        }

        const { targetParentDocId, triggerBlockId } = await this.resolvePasteTargetContext(detail);
        if (!targetParentDocId) {
            this.logEvent("user.paste.doc-clipboard.invalid-target");
            return false;
        }

        this.pendingTriggerBind = { parentDocId: targetParentDocId, triggerBlockId };

        const pastePlan = await this.resolveClipboardPasteStrategy(state);
        this.logEvent("user.paste.strategy", {
            clipboardMode: state.mode,
            strategy: pastePlan.strategy,
            reason: pastePlan.reason,
            subDocId: state.subDocId,
            existingBlocks: pastePlan.existingBlocks || null,
            canonicalBlockId: pastePlan.canonicalBlockId || null,
        });
        if (pastePlan.strategy === "invalid") {
            clearDocClipboardState();
            this.logEvent("user.paste.doc-clipboard.invalid-doc-missing", { subDocId: state.subDocId });
            return false;
        }

        const reuseOriginal = pastePlan.strategy === "reuse";
        if (!reuseOriginal && state.mode === DOC_CLIPBOARD_MODE_CUT) {
            this.promoteCutClipboardToCopy(state, `paste-${pastePlan.reason}`);
            this.logEvent("user.paste.cut-fallback-copy", {
                subDocId: state.subDocId,
                reason: pastePlan.reason,
            });
        }

        let subDocId = null;
        let titleHint = state.sourceTitle || "未命名";
        const pasteSource = reuseOriginal ? "clipboard-cut-paste" : "clipboard-copy-paste";

        if (reuseOriginal) {
            subDocId = state.subDocId;
            this.markRecentDocMove(subDocId, targetParentDocId);
            await this.enqueueSubDocSync(subDocId, () =>
                this.moveSubDocToParent(subDocId, targetParentDocId, pasteSource),
            );
            titleHint = cleanTitle(await getDocTitle(subDocId)) || titleHint;
            this.logEvent("user.paste.reuse.move-doc", {
                subDocId,
                targetParentDocId,
                triggerBlockId,
            });
        } else {
            const duplicated = await this.createCopiedSubDocForPaste(state.subDocId, targetParentDocId, state.sourceTitle);
            if (!duplicated?.subDocId) {
                this.logEvent("user.paste.duplicate-failed", {
                    sourceSubDocId: state.subDocId,
                    targetParentDocId,
                });
                return false;
            }
            subDocId = duplicated.subDocId;
            titleHint = duplicated.title;
            this.markRecentCreate(targetParentDocId, subDocId);
            this.logEvent("user.paste.duplicate-created", {
                sourceSubDocId: state.subDocId,
                newSubDocId: subDocId,
                targetParentDocId,
            });
        }

        try {
            const bound = await this.bindSubDocBlock(
                targetParentDocId,
                subDocId,
                pasteSource,
                titleHint,
                triggerBlockId,
            );
            if (!bound) {
                this.logEvent("user.paste.doc-clipboard.bind-failed", {
                    strategy: pastePlan.strategy,
                    subDocId,
                    targetParentDocId,
                });
                return false;
            }

            const pasteProtyle = detail?.protyle || getActiveProtyleFromEditors();
            syncToolbarRangeOnBlock(pasteProtyle, triggerBlockId, null);
            pushProtyleBackStack(pasteProtyle, triggerBlockId, null);

            if (reuseOriginal) {
                clearDocClipboardState();
            }
            this.logEvent("user.paste.doc-clipboard.done", {
                strategy: pastePlan.strategy,
                reason: pastePlan.reason,
                subDocId,
                targetParentDocId,
                inferred: !!state.inferred,
            });
            return true;
        } finally {
            this.pendingTriggerBind = null;
            if (subDocId) {
                window.setTimeout(() => this.pluginInitiatedSubDocs.delete(subDocId), 5000);
            }
        }
    }

    /**
     * paste 事件同步入口。
     *
     * 关键约束（对应 SiYuan 插件示例的官方说明）：
     * “如果需异步处理请调用 preventDefault，否则会进行默认处理；
     *   如果使用了 preventDefault，必须调用 resolve，否则程序会卡死”。
     *
     * 之前的实现是 `async handlePasteEvent` 整个函数一路 await 到底才调用
     * `event.preventDefault()`，SiYuan 在 emit "paste" 之后会同步检查
     * `event.defaultPrevented`：只要我们还没来得及跑完前面的 await，
     * SiYuan 就已经按默认粘贴处理插入内容了。随后插件的异步逻辑又另外
     * 创建/绑定了一次块，两边各自提交事务，互相打架，
     * 这正是日志里 `txerr` / “invalid data tree” 的根因。
     *
     * 修复方式：在这里同步判断“是否要接管这次粘贴”，如果要接管，
     * 必须在本函数返回之前（不能有任何 await）调用 preventDefault，
     * 再把真正的异步处理转到 finishDocClipboardPaste 里执行；
     * 无论后续异步逻辑成功与否，最终都必须调用一次 detail.resolve，
     * 避免卡死编辑器。
     */
    handlePasteEvent(event) {
        const detail = event?.detail;
        if (!detail) {
            return;
        }
        this.logEvent("user.paste.raw", {
            hasSiyuanHTML: !!detail.siyuanHTML,
            hasTextHTML: !!detail.textHTML,
            textPlainLength: String(detail.textPlain || "").length,
        });

        const clipboardState = inferDocBlockPasteState(detail);
        if (clipboardState?.subDocId && clipboardState?.mode) {
            event.preventDefault();
            const noopPayload = resolvePasteNoop(detail);
            detail.__docBlockPasteResolved = true;
            this.logEvent("user.paste.doc-clipboard.claimed", {
                mode: clipboardState.mode,
                subDocId: clipboardState.subDocId,
                inferred: !!clipboardState.inferred,
                corrupted: clipboardHasCorruptedDocBlockDom(detail.siyuanHTML, detail.textHTML, detail.textPlain),
                resolveTiming: "sync",
                resolvePayload: noopPayload,
            });
            this.finishDocClipboardPaste(event, detail, clipboardState);
            return;
        }

        if (clipboardHasCorruptedDocBlockDom(detail.siyuanHTML, detail.textHTML, detail.textPlain)) {
            event.preventDefault();
            resolvePasteNoop(detail);
            detail.__docBlockPasteResolved = true;
            this.logEvent("user.paste.corrupted-dom-blocked", {});
            showMessage(this.i18n?.createBlockFailed || "文档块粘贴失败：剪贴板内容已损坏，请重新复制后再粘贴");
            return;
        }

        const processed = processPasteContent(detail.siyuanHTML, detail.textHTML, detail.textPlain, detail.protyle);
        if (!processed.changed) {
            return;
        }
        event.preventDefault();
        detail.resolve({
            textHTML: processed.textHTML,
            textPlain: processed.textPlain,
            siyuanHTML: processed.siyuanHTML,
        });
    }

    /** event.preventDefault() 与 detail.resolve 已在 handlePasteEvent 同步完成；这里只负责异步创建/绑定。 */
    async finishDocClipboardPaste(event, detail, state) {
        try {
            const handled = await this.tryHandleDocClipboardPaste(event, detail, state);
            if (handled) {
                return;
            }
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}]`, "finishDocClipboardPaste failed", error);
            this.logEvent("user.paste.doc-clipboard.exception", {
                message: String(error?.message || error),
            });
        }
        if (detail.__docBlockPasteResolved) {
            this.logEvent("user.paste.doc-clipboard.async-failed-after-sync-resolve", {});
            showMessage(this.i18n?.createBlockFailed || "文档块粘贴失败");
            return;
        }
        this.resolvePasteWithFallback(detail);
    }

    /** 已 preventDefault 但插件自定义处理未成功时的兜底：优先退回“内容规范化”结果，否则原样恢复剪贴板内容，确保 resolve 一定被调用。 */
    resolvePasteWithFallback(detail) {
        const processed = processPasteContent(detail.siyuanHTML, detail.textHTML, detail.textPlain, detail.protyle);
        if (processed.changed) {
            detail.resolve({
                textHTML: processed.textHTML,
                textPlain: processed.textPlain,
                siyuanHTML: processed.siyuanHTML,
            });
        } else {
            detail.resolve({
                textHTML: detail.textHTML || "",
                textPlain: detail.textPlain || "",
                siyuanHTML: detail.siyuanHTML || "",
            });
        }
        this.logEvent("user.paste.doc-clipboard.fallback-resolve", {});
    }

    async resolveDocBlockIds(subDocId) {
        const fromSql = await findSubDocBlockIds(subDocId);
        if (fromSql.length > 0) {
            return fromSql;
        }
        const fromCache = [];
        for (const [blockId, docId] of this.blockToSubDoc) {
            if (docId === subDocId) {
                fromCache.push(blockId);
            }
        }
        return fromCache;
    }

    async reapplyDocBlockAttrs(blockId, docId) {
        if (!blockId || !docId) {
            return false;
        }
        const attrsOk = await writeDocBlockBinding(blockId, docId);
        if (!attrsOk) {
            console.warn(`[${PLUGIN_NAME}]`, "reapplyDocBlockAttrs failed", { blockId, docId });
            return false;
        }
        this.rememberBlockSubDoc(blockId, docId);
        decorateSubDocBlocks(document, this);
        return true;
    }

    async convertBlockToDocRef(blockId, docId, source, titleHint = null) {
        if (!blockId || !docId) {
            return;
        }
        const title = cleanTitle(titleHint || await getDocTitle(docId)) || "未命名";
        console.log(`[${PLUGIN_NAME}]`, "convertBlockToDocRef", { blockId, docId, source });
        const response = await fetchSyncPost("/api/block/updateBlock", {
            id: blockId,
            dataType: "markdown",
            data: buildDocRefMarkdown(docId, title),
        });
        if (response.code !== 0) {
            console.warn(`[${PLUGIN_NAME}]`, "convertBlockToDocRef failed", response);
        }
        this.forgetBlockSubDoc(blockId);
    }

    registerProtyleSlash() {
        this.protyleSlash = [{
            filter: ["子文档", "zwd", "subdoc", "sub-doc", "ziwd", "z"],
            html: `<span>${this.i18n.slashSubDoc}</span>`,
            id: "subDocBlock",
            callback: (protyle, nodeElement) => {
                this.createSubDocFromSlash(protyle, nodeElement).catch((error) => {
                    console.warn(`[${PLUGIN_NAME}]`, "createSubDocFromSlash failed", error);
                });
            },
        }];
    }

    async cleanupSlashTrigger(protyle, nodeElement, blockIdHint = null) {
        let blockId = blockIdHint;
        if (!blockId && nodeElement) {
            blockId = nodeElement.getAttribute?.("data-node-id")
                || nodeElement.closest?.("[data-node-id]")?.getAttribute("data-node-id")
                || null;
        }
        if (!blockId) {
            blockId = protyle?.block?.id
                || protyle?.getInstance?.()?.block?.id
                || null;
        }
        await this.cleanupSlashTriggerByBlockId(blockId);
    }

    async cleanupSlashTriggerByBlockId(blockId) {
        if (!blockId) {
            return;
        }
        const rootId = await getBlockRootId(blockId);
        if (!rootId || blockId === rootId) {
            return;
        }
        if (!(await isBlockRowPresent(blockId))) {
            return;
        }
        const response = await fetchSyncPost("/api/block/getBlockKramdown", { id: blockId });
        const raw = response.data?.kramdown || "";
        const text = cleanTitle(raw).replace(/^\/+/, "").trim();
        if (isSlashTriggerContent(raw, text)) {
            await fetchSyncPost("/api/block/deleteBlock", { id: blockId });
        }
    }

    async createSubDocFromSlash(protyle, nodeElement) {
        const { rootDocId, blockId: triggerBlockId, protyle: resolvedProtyle } = await resolveSlashProtyleContext(protyle, nodeElement);
        this.logEvent("slash.create.context", {
            rootDocId,
            triggerBlockId,
            hasNodeElement: !!nodeElement,
            activeRootId: resolvedProtyle?.block?.rootID || resolvedProtyle?.block?.rootId || null,
            triggerRootId: triggerBlockId ? await getBlockRootId(triggerBlockId) : null,
        });
        if (!rootDocId) {
            console.warn(`[${PLUGIN_NAME}]`, "createSubDocFromSlash: parent doc not found", { protyle, nodeElement });
            showMessage(this.i18n.createDocFailed);
            return;
        }

        clearSlashTextInBlock(nodeElement);
        syncSlashToolbarRange(resolvedProtyle, nodeElement);
        this.slashInProgressForParent = rootDocId;
        this.pendingTriggerBind = { parentDocId: rootDocId, triggerBlockId };
        try {
            const title = "未命名";
            const subDocId = await this.createSubDocUnderParent(rootDocId, title);
            if (!subDocId) {
                return;
            }

            this.markRecentCreate(rootDocId, subDocId);
            const bound = await this.bindSubDocBlock(
                rootDocId, subDocId, "slash-create", title, triggerBlockId,
            );
            if (!bound) {
                showMessage(this.i18n.createBlockFailed);
                return;
            }

            syncToolbarRangeOnBlock(resolvedProtyle, triggerBlockId, nodeElement);
            const pushedBack = pushProtyleBackStack(resolvedProtyle, triggerBlockId, nodeElement);
            this.logEvent("slash.create.pushBack", {
                pushedBack,
                triggerBlockId,
                parentDocId: rootDocId,
                backStackSize: window.siyuan?.backStack?.length || 0,
            });
            if (this.app) {
                openTab({
                    app: this.app,
                    doc: { id: subDocId },
                });
            }
        } finally {
            this.slashInProgressForParent = null;
            this.pendingTriggerBind = null;
        }
    }

    async createSubDocUnderParent(parentDocId, title, preferredSubDocId = null) {
        this.creatingSubDocForParent.add(parentDocId);
        try {
            const parentRow = await getDocumentRow(parentDocId);
            if (!parentRow) {
                console.warn(`[${PLUGIN_NAME}]`, "createSubDocUnderParent: parent doc not found", parentDocId);
                showMessage(this.i18n.createDocFailed);
                return null;
            }

            const pathInfo = await getPathInfoByDocId(parentDocId);
            const notebook = pathInfo?.notebook;
            if (!notebook) {
                console.warn(`[${PLUGIN_NAME}]`, "createSubDocUnderParent: notebook missing", parentDocId, pathInfo);
                showMessage(this.i18n.createDocFailed);
                return null;
            }

            const childTitle = title || "未命名";
            if (!pathInfo?.path) {
                console.warn(`[${PLUGIN_NAME}]`, "createSubDocUnderParent: storage path missing", parentDocId, pathInfo);
                showMessage(this.i18n.createDocFailed);
                return null;
            }

            // 禁止使用 createDocWithMd + hpath：同名文档（如多个「未命名」）会导致子文档挂到错误父文档下。
            const subDocId = preferredSubDocId || generateNodeId();
            const newPath = buildChildStoragePath(pathInfo.path, subDocId);
            const response = await fetchSyncPost("/api/filetree/createDoc", {
                notebook,
                path: newPath,
                title: childTitle,
                md: "",
            });
            if (response.code !== 0) {
                console.warn(`[${PLUGIN_NAME}]`, "createDoc failed", response);
                showMessage(`${this.i18n.createDocFailed}: ${response.msg || ""}`);
                return null;
            }
            const createdId = typeof response.data === "string" ? response.data : response.data?.id;
            return createdId || subDocId;
        } finally {
            window.setTimeout(() => this.creatingSubDocForParent.delete(parentDocId), 3000);
        }
    }

    markSubDocMoving(subDocId) {
        if (!subDocId) {
            return;
        }
        this.movingSubDocIds.add(subDocId);
        window.setTimeout(() => this.movingSubDocIds.delete(subDocId), MOVE_GUARD_MS);
    }

    async onSubDocRemovedFromTree(docId, blockIdHint, source) {
        if (!docId || this.syncingDeleteBlockForDoc.has(docId)) {
            return;
        }

        this.syncingDeleteBlockForDoc.add(docId);
        try {
            const blockId = blockIdHint || await getPrimaryDocBlockId(docId);
            if (!blockId || !(await isBlockRowPresent(blockId))) {
                console.log(`[${PLUGIN_NAME}]`, "onSubDocRemovedFromTree skip: block missing", { docId, blockId, source });
                return;
            }
            this.forgetBlockSubDoc(blockId);
            const response = await fetchSyncPost("/api/block/deleteBlock", { id: blockId });
            console.log(`[${PLUGIN_NAME}]`, "onSubDocRemovedFromTree", { docId, blockId, source, response });
        } finally {
            window.setTimeout(() => this.syncingDeleteBlockForDoc.delete(docId), DELETE_GUARD_MS);
        }
    }

    async removeSubDocBlocksOnRootMove(subDocId, source) {
        if (!subDocId || this.syncingDeleteBlockForDoc.has(subDocId)) {
            return false;
        }

        const blockIds = await findSubDocBlockIds(subDocId);
        if (blockIds.length === 0) {
            await clearDocBlockIdOnDoc(subDocId);
            return false;
        }

        this.syncingDeleteBlockForDoc.add(subDocId);
        this.markSubDocMoving(subDocId);
        let removed = false;
        try {
            for (const blockId of blockIds) {
                if (!(await isBlockRowPresent(blockId))) {
                    continue;
                }
                this.forgetBlockSubDoc(blockId);
                const response = await fetchSyncPost("/api/block/deleteBlock", { id: blockId });
                console.log(`[${PLUGIN_NAME}]`, `removeSubDocBlocksOnRootMove(${source})`, { subDocId, blockId, response });
                if (response.code === 0) {
                    removed = true;
                }
            }
            await clearDocBlockIdOnDoc(subDocId);
        } finally {
            window.setTimeout(() => this.syncingDeleteBlockForDoc.delete(subDocId), DELETE_GUARD_MS);
        }
        return removed;
    }

    async onDocBlockRemoved(blockId, source, subDocIdHint = null) {
        if (!blockId) {
            return;
        }

        const subDocId = subDocIdHint || await resolveSubDocIdForDeletedBlock(blockId, null);
        if (!subDocId) {
            this.forgetBlockSubDoc(blockId);
            return;
        }
        if (this.syncingDeleteBlockForDoc.has(subDocId)) {
            console.log(`[${PLUGIN_NAME}]`, "onDocBlockRemoved skip: tree-delete sync", { blockId, subDocId, source });
            this.forgetBlockSubDoc(blockId);
            return;
        }
        if (!(await isDocumentPresent(subDocId))) {
            console.log(`[${PLUGIN_NAME}]`, "onDocBlockRemoved skip: doc missing", { blockId, subDocId, source });
            this.forgetBlockSubDoc(blockId);
            return;
        }
        if (this.syncingTrashDocForBlock.has(subDocId) || this.trashingSubDocIds.has(subDocId)) {
            this.forgetBlockSubDoc(blockId);
            return;
        }
        if (!(await this.isCanonicalOwnerBlock(subDocId, blockId))) {
            this.forgetBlockSubDoc(blockId);
            return;
        }

        this.forgetBlockSubDoc(blockId);
        this.scheduleDocMove(subDocId, "trash", { blockId, source });
    }

    markBlockMoving(subDocId) {
        if (!subDocId) {
            return;
        }
        this.movingBlocksForDoc.add(subDocId);
        window.setTimeout(() => this.movingBlocksForDoc.delete(subDocId), MOVE_GUARD_MS);
    }

    onLayoutReady() {
        decorateSubDocBlocks(document, this);
        bindFileTreeClick(this);
        this.refreshBlockSubDocCache("layout-ready").catch((error) => {
            console.warn(`[${PLUGIN_NAME}]`, "refreshBlockSubDocCache failed", error);
        });
        Promise.resolve(this.configReady).then(() => {
            if (this.config.autoClearTrashOnStartup) {
                return this.clearUnreferencedTrashDocs("startup");
            }
            return null;
        }).catch((error) => {
            console.warn(`[${PLUGIN_NAME}]`, "auto clear trash failed", error);
        });
        console.log(`${PLUGIN_NAME} 插件已启用`);
    }

    applyPluginConfig(data) {
        const next = { ...DEFAULT_CONFIG };
        if (data && typeof data === "object") {
            if (Number.isFinite(Number(data.docBlockHeadingLevel))) {
                const level = Number(data.docBlockHeadingLevel);
                if (level >= 0 && level <= 6) {
                    next.docBlockHeadingLevel = level;
                }
            }
            if (typeof data.fileTreeClickToggle === "boolean") {
                next.fileTreeClickToggle = data.fileTreeClickToggle;
            } else if (typeof data.fileTreeDblClickToggle === "boolean") {
                next.fileTreeClickToggle = data.fileTreeDblClickToggle;
            }
            if (typeof data.autoClearTrashOnStartup === "boolean") {
                next.autoClearTrashOnStartup = data.autoClearTrashOnStartup;
            }
            if (typeof data.debugReconcile === "boolean") {
                next.debugReconcile = data.debugReconcile;
            }
        }
        this.config = next;
    }

    async loadPluginConfig() {
        try {
            const data = await this.loadData(CONFIG_STORAGE);
            this.applyPluginConfig(data);
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}]`, "loadPluginConfig failed", error);
            this.applyPluginConfig(null);
        }
    }

    async savePluginConfig() {
        await this.saveData(CONFIG_STORAGE, this.config);
    }

    initSettingPanel() {
        this.setting = new Setting({
            width: "640px",
            height: "520px",
            confirmCallback: () => {
                this.savePluginConfig().then(() => {
                    showMessage(this.i18n.settingsSaved);
                }).catch((error) => {
                    console.warn(`[${PLUGIN_NAME}]`, "savePluginConfig failed", error);
                    showMessage(this.i18n.settingsSaveFailed);
                });
            },
        });
    }

    buildSettingItems() {
        this.setting.addItem({
            title: this.i18n.docBlockHeadingLevel,
            description: this.i18n.docBlockHeadingLevelDesc,
            createActionElement: () => {
                const select = document.createElement("select");
                select.className = "b3-select fn__flex-center fn__size200";
                const options = [
                    { value: "0", label: this.i18n.headingLevel0 },
                    { value: "1", label: this.i18n.headingLevel1 },
                    { value: "2", label: this.i18n.headingLevel2 },
                    { value: "3", label: this.i18n.headingLevel3 },
                    { value: "4", label: this.i18n.headingLevel4 },
                    { value: "5", label: this.i18n.headingLevel5 },
                    { value: "6", label: this.i18n.headingLevel6 },
                ];
                for (const option of options) {
                    const el = document.createElement("option");
                    el.value = option.value;
                    el.textContent = option.label;
                    select.appendChild(el);
                }
                select.value = String(getDocBlockHeadingLevel(this));
                select.addEventListener("change", () => {
                    this.config.docBlockHeadingLevel = Number(select.value);
                });
                return select;
            },
        });
        this.setting.addItem({
            title: this.i18n.fileTreeClickToggle,
            description: this.i18n.fileTreeClickToggleDesc,
            createActionElement: () => {
                const input = document.createElement("input");
                input.className = "b3-switch";
                input.type = "checkbox";
                input.checked = this.config.fileTreeClickToggle !== false;
                input.addEventListener("change", () => {
                    this.config.fileTreeClickToggle = input.checked;
                });
                return input;
            },
        });
        this.setting.addItem({
            title: this.i18n.autoClearTrashOnStartup,
            description: this.i18n.autoClearTrashOnStartupDesc,
            createActionElement: () => {
                const input = document.createElement("input");
                input.className = "b3-switch";
                input.type = "checkbox";
                input.checked = !!this.config.autoClearTrashOnStartup;
                input.addEventListener("change", () => {
                    this.config.autoClearTrashOnStartup = input.checked;
                });
                return input;
            },
        });
        this.setting.addItem({
            title: this.i18n.debugReconcile,
            description: this.i18n.debugReconcileDesc,
            createActionElement: () => {
                const input = document.createElement("input");
                input.className = "b3-switch";
                input.type = "checkbox";
                input.checked = !!this.config.debugReconcile;
                input.addEventListener("change", () => {
                    this.config.debugReconcile = input.checked;
                });
                return input;
            },
        });
        const clearBtn = document.createElement("button");
        clearBtn.className = "b3-button b3-button--outline fn__flex-center fn__size200";
        clearBtn.textContent = this.i18n.clearTrashNow;
        clearBtn.addEventListener("click", () => {
            this.clearUnreferencedTrashDocs("manual").catch((error) => {
                console.warn(`[${PLUGIN_NAME}]`, "clearUnreferencedTrashDocs failed", error);
                showMessage(this.i18n.clearTrashFailed);
            });
        });
        this.setting.addItem({
            title: this.i18n.clearTrashNow,
            description: this.i18n.clearTrashNowDesc,
            direction: "row",
            actionElement: clearBtn,
        });
    }

    openSetting() {
        Promise.resolve(this.configReady).then(() => {
            this.initSettingPanel();
            this.buildSettingItems();
            this.setting.open(this.displayName);
        });
    }

    registerTopBarEntry() {
        if (this.topBarEntry) {
            return;
        }
        this.topBarEntry = this.addTopBar({
            icon: "iconSettings",
            title: this.i18n.openSubDocBlockSetting,
            position: "right",
            callback: () => {
                this.openSetting();
            },
        });
    }

    async clearUnreferencedTrashDocs(source) {
        if (this.clearingTrash) {
            return { deleted: 0, kept: 0, skipped: true };
        }
        this.clearingTrash = true;
        try {
            if (source === "manual") {
                showMessage(this.i18n.clearTrashRunning);
            }
            const trashNotebookId = await this.ensureTrashNotebook();
            if (!trashNotebookId) {
                if (source === "manual") {
                    showMessage(this.i18n.trashNotebookFailed);
                }
                return { deleted: 0, kept: 0 };
            }
            const docIds = await listDocIdsInNotebook(trashNotebookId);
            let deleted = 0;
            let kept = 0;
            for (const docId of docIds) {
                if (await isTrashDocReferenced(docId)) {
                    kept++;
                    continue;
                }
                const title = await getDocTitle(docId);
                const response = await fetchSyncPost("/api/filetree/removeDocByID", { id: docId });
                if (response.code === 0) {
                    deleted++;
                    this.clearDocMovePending(docId);
                    showMessage(this.i18n.clearTrashDeletedOne
                        .replace("${title}", title)
                        .replace("${id}", docId));
                } else {
                    console.warn(`[${PLUGIN_NAME}]`, "clearUnreferencedTrashDocs remove failed", docId, response);
                }
            }
            console.log(`[${PLUGIN_NAME}]`, `clearUnreferencedTrashDocs(${source})`, { deleted, kept, total: docIds.length });
            return { deleted, kept };
        } finally {
            this.clearingTrash = false;
        }
    }

    async resolveTrashNotebook() {
        const notebook = await findTrashNotebook();
        this.trashNotebookId = notebook?.id || null;
        return notebook;
    }

    /** 定位垃圾箱笔记本；不存在则自动创建后再返回 id */
    async ensureTrashNotebook() {
        this.logEvent("trash.ensure.start");
        if (this.trashNotebookEnsurePromise) {
            return this.trashNotebookEnsurePromise;
        }
        this.trashNotebookEnsurePromise = this._ensureTrashNotebookImpl();
        try {
            return await this.trashNotebookEnsurePromise;
        } finally {
            this.trashNotebookEnsurePromise = null;
        }
    }

    async _ensureTrashNotebookImpl() {
        let notebook = await findTrashNotebook();
        if (notebook?.id) {
            this.trashNotebookId = notebook.id;
            this.logEvent("trash.ensure.found", { notebookId: notebook.id });
            console.log(`[${PLUGIN_NAME}]`, "ensureTrashNotebook found by name", notebook.id);
            return notebook.id;
        }

        this.logEvent("trash.ensure.create", { name: TRASH_NOTEBOOK_NAME });
        console.log(`[${PLUGIN_NAME}]`, "ensureTrashNotebook creating", TRASH_NOTEBOOK_NAME);
        const response = await fetchSyncPost("/api/notebook/createNotebook", {
            name: TRASH_NOTEBOOK_NAME,
            icon: "iconTrashcan",
        });

        notebook = await waitForTrashNotebook();
        if (notebook?.id) {
            this.trashNotebookId = notebook.id;
            this.logEvent("trash.ensure.ready", { notebookId: notebook.id, createCode: response.code, createMsg: response.msg });
            console.log(`[${PLUGIN_NAME}]`, "ensureTrashNotebook ready", notebook.id, { createCode: response.code });
            return notebook.id;
        }

        if (response.code !== 0) {
            showMessage(`${this.i18n.trashNotebookFailed}: ${response.msg}`);
        } else {
            showMessage(this.i18n.trashNotebookFailed);
        }
        this.trashNotebookId = null;
        this.logEvent("trash.ensure.failed", { code: response.code, msg: response.msg });
        return null;
    }

    async isSubDocInTrash(subDocId) {
        if (!subDocId) {
            return false;
        }
        const trashNotebook = await this.resolveTrashNotebook();
        if (!trashNotebook) {
            return false;
        }
        const notebookId = await getDocNotebookIdFromSql(subDocId);
        return notebookId === trashNotebook.id;
    }

    markSubDocTrashing(subDocId) {
        if (!subDocId) {
            return;
        }
        this.trashingSubDocIds.add(subDocId);
        window.setTimeout(() => this.trashingSubDocIds.delete(subDocId), DELETE_GUARD_MS);
    }

    async hasOtherSubDocBlocks(subDocId, excludeBlockId) {
        const blockIds = await findSubDocBlockIds(subDocId);
        return blockIds.some((id) => id !== excludeBlockId);
    }

    async isCanonicalOwnerBlock(subDocId, blockId) {
        if (!subDocId || !blockId) {
            return false;
        }
        const canonicalBlockId = await getDocBlockIdFromDoc(subDocId);
        if (canonicalBlockId) {
            return canonicalBlockId === blockId;
        }
        const binding = await getDocBlockBindingFromBlockId(blockId);
        return binding?.subDocId === subDocId;
    }

    clearDocMovePending(subDocId) {
        const pending = this.docMovePending.get(subDocId);
        if (!pending) {
            return;
        }
        if (pending.timer) {
            window.clearTimeout(pending.timer);
        }
        this.docMovePending.delete(subDocId);
    }

    scheduleDocMove(subDocId, intent, meta = {}) {
        if (!subDocId || (intent !== "trash" && intent !== "restore")) {
            return;
        }
        const { blockId, parentDocId, source = "doc-move" } = meta;
        let pending = this.docMovePending.get(subDocId);
        if (!pending) {
            pending = { intent, source };
            this.docMovePending.set(subDocId, pending);
        }
        pending.intent = intent;
        pending.source = source;
        if (blockId) {
            pending.blockId = blockId;
        }
        if (parentDocId) {
            pending.parentDocId = parentDocId;
        }
        pending.updatedAt = Date.now();
        if (intent === "trash") {
            this.ensureTrashNotebook().catch((error) => {
                console.warn(`[${PLUGIN_NAME}]`, "ensureTrashNotebook before trash move failed", error);
            });
        }
        if (pending.timer) {
            window.clearTimeout(pending.timer);
        }
        pending.timer = window.setTimeout(() => {
            this.flushDocMove(subDocId).catch((error) => {
                console.warn(`[${PLUGIN_NAME}]`, "flushDocMove failed", subDocId, error);
            });
        }, DOC_MOVE_DEBOUNCE_MS);
        this.logEvent("doc-move.schedule", { subDocId, intent, blockId, parentDocId, source });
        console.log(`[${PLUGIN_NAME}]`, "scheduleDocMove", { subDocId, intent, blockId, parentDocId, source });
    }

    async flushDocMove(subDocId) {
        const pending = this.docMovePending.get(subDocId);
        if (!pending) {
            return;
        }
        this.docMovePending.delete(subDocId);
        if (pending.timer) {
            window.clearTimeout(pending.timer);
        }

        await fetchSyncPost("/api/sqlite/flushTransaction", {});
        const { intent, blockId, parentDocId, source } = pending;
        this.logEvent("doc-move.flush", { subDocId, intent, blockId, parentDocId, source });

        if (intent === "trash") {
            const trashNotebookId = await this.ensureTrashNotebook();
            if (!trashNotebookId) {
                console.warn(`[${PLUGIN_NAME}]`, "flushDocMove trash aborted: no trash notebook", { subDocId, source });
                return;
            }
            await this.moveSubDocsToTrash([subDocId], source);
            return;
        }

        if (intent === "restore") {
            let destParentDocId = parentDocId;
            if (!destParentDocId && blockId) {
                destParentDocId = await getBlockRootId(blockId);
            }
            if (!destParentDocId) {
                console.warn(`[${PLUGIN_NAME}]`, `flushDocMove restore missing parent`, { subDocId, blockId, source });
                return;
            }
            const inTrash = await this.isSubDocInTrash(subDocId);
            if (!inTrash) {
                const currentParent = await resolveParentDocIdFromSql(subDocId);
                if (currentParent === destParentDocId) {
                    console.log(`[${PLUGIN_NAME}]`, `flushDocMove skip restore: already at parent`, { subDocId, destParentDocId, source });
                    return;
                }
                console.log(`[${PLUGIN_NAME}]`, `flushDocMove skip restore: not in trash`, { subDocId, source });
                return;
            }
            if (blockId) {
                this.rememberBlockSubDoc(blockId, subDocId);
            }
            await this.moveSubDocToParent(subDocId, destParentDocId, source);
        }
    }

    async moveSubDocsToTrash(subDocIds, source) {
        const trashNotebookId = await this.ensureTrashNotebook();
        if (!trashNotebookId) {
            console.warn(`[${PLUGIN_NAME}]`, `moveSubDocsToTrash(${source}) aborted: no trash notebook`, subDocIds);
            this.logEvent("doc-move.to-trash.aborted", { source, subDocIds });
            return;
        }

        const ids = [];
        for (const id of [...new Set((subDocIds || []).filter(Boolean))]) {
            if (this.trashingSubDocIds.has(id) || this.syncingDeleteBlockForDoc.has(id)) {
                continue;
            }
            if (!(await isDocumentPresent(id))) {
                continue;
            }
            if (await this.isSubDocInTrash(id)) {
                continue;
            }
            ids.push(id);
        }
        if (ids.length === 0) {
            return;
        }

        ids.forEach((id) => {
            this.markSubDocTrashing(id);
            this.markSubDocMoving(id);
        });
        const response = await fetchSyncPost("/api/filetree/moveDocsByID", {
            fromIDs: ids,
            toID: trashNotebookId,
        });
        this.logEvent("doc-move.to-trash", {
            source,
            subDocIds: ids,
            trashNotebookId,
            code: response.code,
            msg: response.msg,
        });
        console.log(`[${PLUGIN_NAME}]`, `moveSubDocsToTrash(${source})`, { subDocIds: ids, trashNotebookId }, response);
        if (response.code !== 0 && (await Promise.all(ids.map((id) => isDocumentPresent(id)))).some(Boolean)) {
            showMessage(`${this.i18n.moveToTrashFailed}: ${response.msg}`);
        }
    }

    async refreshBlockSubDocCache(source) {
        const rows = await loadAllSubDocBlockMappings();
        rows.forEach((row) => this.rememberBlockSubDoc(row.id, row.sub_doc_id));
        console.log(`[${PLUGIN_NAME}]`, `refreshBlockSubDocCache(${source})`, rows.length);
    }

    scheduleRefreshBlockSubDocCache(source) {
        if (this.cacheRefreshTimer) {
            window.clearTimeout(this.cacheRefreshTimer);
        }
        this.cacheRefreshTimer = window.setTimeout(() => {
            this.cacheRefreshTimer = null;
            this.refreshBlockSubDocCache(source).catch((error) => {
                console.warn(`[${PLUGIN_NAME}]`, "refreshBlockSubDocCache failed", error);
            });
        }, 300);
    }

    rememberBlockSubDoc(blockId, subDocId) {
        if (blockId && subDocId) {
            this.blockToSubDoc.set(blockId, subDocId);
        }
    }

    markRecentBoundSubDoc(subDocId, blockId) {
        if (!subDocId) {
            return;
        }
        this.recentBoundSubDocs.set(subDocId, { at: Date.now(), blockId: blockId || null });
    }

    isRecentBoundSubDoc(subDocId) {
        const entry = this.recentBoundSubDocs.get(subDocId);
        return !!entry && Date.now() - entry.at < 3000;
    }

    async replaceTriggerBlockWithSubDoc(triggerBlockId, parentDocId, subDocId, source, title) {
        if (!(await isBlockRowPresent(triggerBlockId))) {
            await ensureBlockReadyAfterSignal(triggerBlockId);
        }
        if (!(await isBlockRowPresent(triggerBlockId))) {
            return false;
        }

        const headingLevel = getDocBlockHeadingLevel(this);
        let markdown = await buildSubDocBlockMarkdownForBlock(subDocId, title, headingLevel, triggerBlockId);
        let updateRes = await fetchSyncPost("/api/block/updateBlock", {
            id: triggerBlockId,
            dataType: "markdown",
            data: markdown,
        });
        if (updateRes.code !== 0) {
            markdown = await buildSubDocBlockMarkdownForBlock(subDocId, title, 0, triggerBlockId);
            updateRes = await fetchSyncPost("/api/block/updateBlock", {
                id: triggerBlockId,
                dataType: "markdown",
                data: markdown,
            });
        }
        if (updateRes.code !== 0) {
            this.logEvent("bind.replace-trigger.failed", {
                triggerBlockId, parentDocId, subDocId, source, code: updateRes.code, msg: updateRes.msg,
            });
            return false;
        }

        this.markRecentCreate(parentDocId, subDocId);
        let finalized = await finalizeDocBlockPresentation(this, triggerBlockId, subDocId);
        if (!finalized) {
            finalized = await finalizeDocBlockPresentation(this, triggerBlockId, subDocId);
        }
        if (finalized) {
            this.logEvent("bind.replace-trigger.done", { triggerBlockId, parentDocId, subDocId, source });
        } else {
            this.logEvent("bind.replace-trigger.finalize-failed", { triggerBlockId, parentDocId, subDocId, source });
        }
        return true;
    }

    forgetBlockSubDoc(blockId) {
        if (blockId) {
            this.blockToSubDoc.delete(blockId);
        }
    }

    async resolveSubDocIdForBlock(blockId) {
        if (!blockId) {
            return null;
        }
        if (this.blockToSubDoc.has(blockId)) {
            return this.blockToSubDoc.get(blockId);
        }
        if (!(await isBlockRowPresent(blockId))) {
            return null;
        }
        const subDocId = await getSubDocIdFromBlock(blockId, { strict: true });
        if (subDocId) {
            this.rememberBlockSubDoc(blockId, subDocId);
        }
        return subDocId;
    }

    /**
     * 同一子文档的移动/绑定操作串行化，避免 fetch+ws 双通道或块/树互相同步打架。
     */
    enqueueSubDocSync(subDocId, task) {
        if (!subDocId) {
            return Promise.resolve();
        }
        const prev = this.subDocSyncChains.get(subDocId) || Promise.resolve();
        const next = prev
            .catch(() => {})
            .then(() => task())
            .catch((error) => {
                console.warn(`[${PLUGIN_NAME}]`, "enqueueSubDocSync failed", subDocId, error);
            });
        this.subDocSyncChains.set(subDocId, next);
        next.finally(() => {
            if (this.subDocSyncChains.get(subDocId) === next) {
                this.subDocSyncChains.delete(subDocId);
            }
        });
        return next;
    }

    enqueueParentSync(parentDocId, task) {
        if (!parentDocId) {
            return Promise.resolve();
        }
        const prev = this.parentSyncChains.get(parentDocId) || Promise.resolve();
        const next = prev
            .catch(() => {})
            .then(() => task())
            .catch((error) => {
                console.warn(`[${PLUGIN_NAME}]`, "enqueueParentSync failed", parentDocId, error);
            });
        this.parentSyncChains.set(parentDocId, next);
        next.finally(() => {
            if (this.parentSyncChains.get(parentDocId) === next) {
                this.parentSyncChains.delete(parentDocId);
            }
        });
        return next;
    }

    isDebugReconcileEnabled() {
        return !!this.config?.debugReconcile;
    }

    debugReconcileLog(tag, payload = {}) {
        this.logEvent(`debug.reconcile.${tag}`, payload);
        if (!this.isDebugReconcileEnabled()) {
            return;
        }
        console.log(`[${PLUGIN_NAME}]`, `[reconcile:${tag}]`, payload);
    }

    pruneRecentMoveEventKeys() {
        const now = Date.now();
        for (const [key, record] of this.recentMoveEventKeys) {
            const ts = record?.at || 0;
            if (now - ts > MOVE_DEDUPE_MS * 6) {
                this.recentMoveEventKeys.delete(key);
            }
        }
    }

    scheduleParentReconcile(parentDocId, mode, source) {
        // 已停用：不再同步同父文档内「文档树顺序 ↔ 文档块顺序」。
        this.logEvent("parent-reconcile.skipped", { parentDocId, mode, source });
    }

    async reconcileParentBlockOrderFromTree(parentDocId, source) {
        const orderedSubDocs = await listChildDocIdsByParentFromTree(parentDocId);
        if (orderedSubDocs.length === 0) {
            this.debugReconcileLog("tree-to-block-empty", { parentDocId, source });
            this.logEvent("parent-reconcile.tree-to-block.empty", { parentDocId, source });
            return;
        }
        const stats = {
            parentDocId,
            source,
            total: orderedSubDocs.length,
            movedBlock: 0,
            boundBlock: 0,
            skipped: 0,
        };
        for (const subDocId of orderedSubDocs) {
            if (!subDocId || !(await isDocumentPresent(subDocId))) {
                stats.skipped++;
                continue;
            }
            const moved = await this.moveSubDocBlockToDoc(subDocId, parentDocId, `${source}-reconcile-tree`);
            if (moved) {
                stats.movedBlock++;
                continue;
            }
            const blockIds = await findSubDocBlockIds(subDocId);
            if (blockIds.length > 0) {
                stats.skipped++;
                continue;
            }
            const title = await getDocTitle(subDocId);
            this.scheduleBindSubDocBlock(parentDocId, subDocId, `${source}-reconcile-tree-bind`, title);
            stats.boundBlock++;
        }
        this.debugReconcileLog("tree-to-block-done", stats);
        this.logEvent("parent-reconcile.tree-to-block.done", stats);
    }

    async reconcileParentTreeOrderFromBlocks(parentDocId, source) {
        const orderedSubDocs = await listDocBlockSubDocOrderInParent(parentDocId);
        if (orderedSubDocs.length === 0) {
            this.debugReconcileLog("block-to-tree-empty", { parentDocId, source });
            this.logEvent("parent-reconcile.block-to-tree.empty", { parentDocId, source });
            return;
        }
        const stats = {
            parentDocId,
            source,
            total: orderedSubDocs.length,
            movedDoc: 0,
            skipped: 0,
        };
        for (const subDocId of orderedSubDocs) {
            if (!subDocId || !(await isDocumentPresent(subDocId)) || await this.isSubDocInTrash(subDocId)) {
                stats.skipped++;
                continue;
            }
            this.markRecentDocMove(subDocId, parentDocId);
            this.markRecentDocMove(subDocId, `${parentDocId}::tree-reorder`);
            await this.moveSubDocToParent(subDocId, parentDocId, `${source}-reconcile-block`);
            stats.movedDoc++;
        }
        this.debugReconcileLog("block-to-tree-done", stats);
        this.logEvent("parent-reconcile.block-to-tree.done", stats);
    }

    /** 快速判断是否为插件管理的子文档（避免对普通文档 move 做重型检索） */
    async isPluginManagedSubDoc(subDocId) {
        if (!subDocId) {
            return false;
        }
        for (const docId of this.blockToSubDoc.values()) {
            if (docId === subDocId) {
                return true;
            }
        }
        if (await getDocBlockIdFromDoc(subDocId)) {
            return true;
        }
        const blockIds = await findSubDocBlockIds(subDocId);
        return blockIds.length > 0;
    }

    shouldSkipPluginInitiatedCreate(parentDocId, subDocId) {
        if (!parentDocId) {
            return false;
        }
        if (subDocId && this.pluginInitiatedSubDocs.has(subDocId)) {
            return true;
        }
        if (this.slashInProgressForParent === parentDocId) {
            return true;
        }
        if (this.creatingSubDocForParent.has(parentDocId)) {
            return true;
        }
        if (subDocId && this.insertingSubDocBlocks.has(subDocId)) {
            return true;
        }
        return false;
    }

    shouldSkipRecentSync(subDocId) {
        const now = Date.now();
        const last = this.recentSyncKeys.get(subDocId);
        if (last && now - last < SYNC_DEDUPE_MS) {
            return true;
        }
        this.recentSyncKeys.set(subDocId, now);
        return false;
    }

    async handleProtyleChange(detail) {
        const blockId = detail?.id;
        if (!blockId || this.pendingBlockCreates.has(blockId)) {
            return;
        }
        this.logEvent("protyle-change", { blockId });
        const attrs = await queryBlockAttrsFromSql(blockId);
        const subDocId = attrs?.[ATTR_DOC_ID] || this.blockToSubDoc.get(blockId) || null;
        const isDocBlock = attrs?.[ATTR_BLOCK] === "1" && subDocId;

        if (isDocBlock) {
            this.rememberBlockSubDoc(blockId, subDocId);
            this.logEvent("protyle-change.remember-binding", {
                blockId,
                subDocId,
            });
            const blockEl = document.querySelector(`[data-node-id="${blockId}"]`);
            if (blockEl) {
                if (docBlockPresentationIsCorrupted(blockEl)) {
                    this.scheduleRepairDocBlock(blockId, subDocId, "protyle-change");
                } else {
                    decorateSubDocBlocks(blockEl, this);
                }
            }
            return;
        }

        const blockEl = document.querySelector(`[data-node-id="${blockId}"]`);
        if (blockEl && isDocBlockLike(blockEl)) {
            const cachedSubDocId = this.blockToSubDoc.get(blockId);
            if (cachedSubDocId) {
                this.scheduleRepairDocBlock(blockId, cachedSubDocId, "protyle-change-cached");
            }
        }
    }

    scheduleRepairDocBlock(blockId, subDocId, source) {
        if (!blockId || !subDocId || this.repairingDocBlocks.has(blockId)) {
            return;
        }
        const existing = this.repairDocBlockTimers.get(blockId);
        if (existing) {
            window.clearTimeout(existing);
        }
        const timer = window.setTimeout(() => {
            this.repairDocBlockTimers.delete(blockId);
            this.repairDocBlockPresentation(blockId, subDocId, source).catch((error) => {
                console.warn(`[${PLUGIN_NAME}]`, "repairDocBlockPresentation failed", error);
            });
        }, 80);
        this.repairDocBlockTimers.set(blockId, timer);
    }

    async repairDocBlockPresentation(blockId, subDocId, source) {
        if (!blockId || !subDocId || this.repairingDocBlocks.has(blockId)) {
            return false;
        }
        this.repairingDocBlocks.add(blockId);
        try {
            const blockEl = document.querySelector(`[data-node-id="${blockId}"]`);
            if (blockEl && isCorrectDocBlockPresentation(blockEl)) {
                decorateSubDocBlocks(blockEl, this);
                return true;
            }

            const title = cleanTitle(await getDocTitle(subDocId)) || "未命名";
            const headingLevel = getDocBlockHeadingLevel(this);
            let markdown = await buildSubDocBlockMarkdownForBlock(subDocId, title, headingLevel, blockId);
            let updateRes = await fetchSyncPost("/api/block/updateBlock", {
                id: blockId,
                dataType: "markdown",
                data: markdown,
            });
            if (updateRes.code !== 0) {
                markdown = await buildSubDocBlockMarkdownForBlock(subDocId, title, 0, blockId);
                updateRes = await fetchSyncPost("/api/block/updateBlock", {
                    id: blockId,
                    dataType: "markdown",
                    data: markdown,
                });
            }
            if (updateRes.code !== 0) {
                this.logEvent("repair.doc-block.failed", {
                    blockId, subDocId, source, code: updateRes.code, msg: updateRes.msg,
                });
                return false;
            }

            const ok = await finalizeDocBlockPresentation(this, blockId, subDocId);
            this.logEvent("repair.doc-block.done", { blockId, subDocId, source, ok });
            return ok;
        } finally {
            this.repairingDocBlocks.delete(blockId);
        }
    }

    async handleWsMain(detail) {
        if (!detail?.cmd) {
            return;
        }
        this.logEvent("ws-main", {
            cmd: detail.cmd,
        });
        if (detail.cmd === "txerr") {
            const clipboardState = getDocClipboardState();
            this.logEvent("ws-main.txerr", {
                clipboardMode: clipboardState?.mode || null,
                clipboardSubDocId: clipboardState?.subDocId || null,
                data: safeSerialize(detail.data),
            });
        }
        if (WS_LOG_CMDS.has(detail.cmd)) {
            console.log(`[${PLUGIN_NAME}]`, "ws-main", detail.cmd, detail.data);
        }

        if (detail.cmd === "removeDoc") {
            for (const docId of detail.data?.ids || []) {
                await this.onSubDocRemovedFromTree(docId, null, "ws-removeDoc");
            }
            return;
        }

        if (detail.cmd === "moveDoc") {
            const fromIDs = detail.data?.fromIDs || detail.data?.ids || [];
            const fromPaths = detail.data?.fromPaths || [];
            const toPath = detail.data?.toPath;
            const toNotebook = detail.data?.toNotebook || detail.data?.box?.id;
            const toID = detail.data?.toID || detail.data?.toId;
            if (fromIDs.length && toID) {
                await this.handleDocMove({
                    fromIDs,
                    toID,
                    byId: true,
                }, "ws-moveDoc");
            } else if (fromPaths.length && toPath != null) {
                await this.handleDocMove({
                    fromPaths,
                    toNotebook,
                    toPath,
                    byId: false,
                }, "ws-moveDoc");
            }
            return;
        }

        if (detail.cmd === "create") {
            const { subDocId, parentDocId } = parseIdsFromStoragePath(detail.data?.path);
            console.log(`[${PLUGIN_NAME}]`, "ws-create parsed", {
                path: detail.data?.path,
                subDocId,
                parentDocId,
                listDocTree: detail.data?.listDocTree,
            });
            if (subDocId && parentDocId) {
                this.onSubDocCreated(subDocId, parentDocId, "ws-create", detail.data?.title);
            }
            return;
        }

        if (detail.cmd === "rename") {
            const docId = detail.data?.id || docIdFromStoragePath(detail.data?.path);
            const title = detail.data?.title;
            if (docId && title) {
                await this.syncSubDocBlockTitle(docId, title, "ws-rename");
            }
            return;
        }

        if (detail.cmd === "savedoc") {
            const docId = detail.data?.rootID || detail.data?.rootId || detail.data?.id;
            if (docId) {
                const title = await getDocTitle(docId);
                await this.syncSubDocBlockTitle(docId, title, "ws-savedoc");
            }
            return;
        }

        if (detail.cmd === "transactions") {
            await this.handleWsTransactions(detail.data);
        }
    }

    async handleWsTransactions(data) {
        const transactions = normalizeWsTransactions(data);
        this.logEvent("ws-transactions.batch", { count: transactions.length });
        for (const tx of transactions) {
            const { deletedSubDocIds, relocated } = await analyzeTransactionSubDocOps(tx, this);
            const ops = tx.doOperations || tx.DoOperations || [];
            this.logEvent("ws-transactions.tx", {
                opCount: ops.length,
                deletedCount: deletedSubDocIds.size,
                relocatedCount: relocated.size,
            });
            const restoringSubDocIds = new Set();

            for (const op of ops) {
                const action = getOpAction(op);
                const blockId = getOpBlockId(op);
                if (!blockId) {
                    continue;
                }
                this.logEvent("ws-transactions.op", {
                    action,
                    blockId,
                    parentID: op?.parentID || op?.parentId || null,
                    previousID: op?.previousID || op?.previousId || null,
                    nextID: op?.nextID || op?.nextId || null,
                    dataId: op?.data?.id || null,
                });

                if (action === "delete") {
                    this.forgetBlockSubDoc(blockId);
                    continue;
                }

                if (action === "move") {
                    const cachedSubDocId = this.blockToSubDoc.get(blockId);
                    if (!cachedSubDocId && !isDocBlockOpData(op.data || op?.Data)) {
                        continue;
                    }
                    await this.syncSubDocParentForBlock(blockId, op, "ws-transactions-move");
                    continue;
                }

                if (action === "insert" || action === "append") {
                    const opData = op.data || op.Data || "";
                    const docIdFromData = extractSubDocIdFromOpData(opData);
                    const isDocBlockInsert = isDocBlockOpData(opData);
                    const pendingTrash = this.docMovePending.get(docIdFromData)?.intent === "trash";
                    const isUndoRestore = docIdFromData && (
                        await this.isSubDocInTrash(docIdFromData)
                        || (isDocBlockOpData(opData) && pendingTrash)
                    );
                    if (isUndoRestore) {
                        const parentDocId = await resolveTargetDocIdForOp(op, blockId, this)
                            || await getBlockRootId(blockId);
                        this.rememberBlockSubDoc(blockId, docIdFromData);
                        const clipboardState = getDocClipboardState();
                        if (
                            clipboardState?.mode === DOC_CLIPBOARD_MODE_CUT
                            && clipboardState.subDocId === docIdFromData
                        ) {
                            this.promoteCutClipboardToCopy(clipboardState, "ws-undo-restore");
                        }
                        this.scheduleDocMove(docIdFromData, "restore", {
                            blockId,
                            parentDocId,
                            source: "ws-undo-restore",
                        });
                        restoringSubDocIds.add(docIdFromData);
                        continue;
                    }
                    if (isDocBlockInsert && docIdFromData) {
                        const canonicalBlockId = await getDocBlockIdFromDoc(docIdFromData);
                        if (canonicalBlockId && canonicalBlockId !== blockId) {
                            const attrs = await queryBlockAttrsFromSql(blockId);
                            if (attrs?.[ATTR_BLOCK] === "1" && attrs?.[ATTR_DOC_ID] === docIdFromData) {
                                this.rememberBlockSubDoc(blockId, docIdFromData);
                                continue;
                            }
                            await this.convertBlockToDocRef(
                                blockId,
                                docIdFromData,
                                "ws-insert-dup",
                                extractTitleFromOpData(opData),
                            );
                            continue;
                        }
                        continue;
                    }
                    if (isDocBlockInsert) {
                        const parentDocId = await getBlockRootId(blockId);
                        if (!parentDocId || !this.creatingSubDocForParent.has(parentDocId)) {
                            this.scheduleEnsureSubDocForBlock(blockId, docIdFromData, "ws-transactions-insert");
                        }
                    } else if (docIdFromData) {
                        // 粘贴/输入的普通块引：仅 DOM 关联，不写入 blockToSubDoc（避免删引用误触发回收）
                    }
                    continue;
                }

                if (action === "update" || action === "updateAttrs" || action === "setAttrs") {
                    const attrs = op.data?.attrs || op.retData?.attrs || op.data;
                    if (attrs?.[ATTR_BLOCK] === "1" && attrs?.[ATTR_DOC_ID]) {
                        await this.ensureSubDocForBlock(blockId, attrs[ATTR_DOC_ID], "ws-transactions-attrs");
                        await this.syncSubDocParentForBlock(blockId, op, "ws-transactions-attrs");
                    }

                    const docRow = await getDocumentRow(blockId);
                    if (!docRow) {
                        continue;
                    }
                    const linkedBlocks = await findSubDocBlockIds(blockId);
                    if (linkedBlocks.length === 0) {
                        continue;
                    }
                    linkedBlocks.forEach((id) => this.rememberBlockSubDoc(id, blockId));
                    const title = cleanTitle(docRow.content) || await getDocTitle(blockId);
                    console.log(`[${PLUGIN_NAME}]`, "ws-transactions update doc -> sync block", { docId: blockId, title });
                    await this.syncSubDocBlockTitle(blockId, title, "ws-transactions");
                }
            }

            for (const [subDocId, blockId] of deletedSubDocIds) {
                if (restoringSubDocIds.has(subDocId)) {
                    continue;
                }
                if (!(await this.isCanonicalOwnerBlock(subDocId, blockId))) {
                    console.log(`[${PLUGIN_NAME}]`, "ws-transactions-delete skip: not owner doc block", { subDocId, blockId });
                    this.forgetBlockSubDoc(blockId);
                    continue;
                }
                this.scheduleDocMove(subDocId, "trash", {
                    blockId,
                    source: "ws-transactions-delete",
                });
                this.forgetBlockSubDoc(blockId);
            }

            for (const [subDocId, targetDocId] of relocated) {
                if (restoringSubDocIds.has(subDocId)) {
                    continue;
                }
                const syncSubDocId = subDocId;
                const syncTargetDocId = targetDocId;
                await this.enqueueSubDocSync(syncSubDocId, () =>
                    this.syncSubDocToTargetParent(syncSubDocId, syncTargetDocId, "ws-transactions-relocate"),
                );
            }
        }
    }

    scheduleEnsureSubDocForBlock(blockId, preferredSubDocId, source) {
        if (!blockId) {
            return;
        }
        ensureBlockReadyAfterSignal(blockId).then((ready) => {
            if (!ready) {
                console.warn(`[${PLUGIN_NAME}]`, `ensureSubDocForBlock(${source}) block not ready`, blockId);
                return;
            }
            return this.ensureSubDocForBlock(blockId, preferredSubDocId, source);
        }).catch((error) => {
            console.warn(`[${PLUGIN_NAME}]`, `ensureSubDocForBlock(${source}) failed`, error);
        });
    }

    async syncSubDocToTargetParent(subDocId, targetParentDocId, source) {
        if (!subDocId || !targetParentDocId || subDocId === targetParentDocId) {
            return;
        }
        if (this.movingSubDocIds.has(subDocId) || this.movingBlocksForDoc.has(subDocId)) {
            return;
        }
        if (targetParentDocId === this.trashNotebookId) {
            return;
        }
        const trashNotebook = await this.resolveTrashNotebook();
        if (trashNotebook && targetParentDocId === trashNotebook.id) {
            return;
        }
        const targetRow = await getDocumentRow(targetParentDocId);
        if (!targetRow) {
            return;
        }
        await flushSqlTransaction();
        const currentParentDocId = await resolveParentDocId(subDocId);
        if (!currentParentDocId || currentParentDocId === targetParentDocId) {
            return;
        }

        const blockIds = await findSubDocBlockIds(subDocId);
        if (blockIds.length > 0) {
            for (const blockId of blockIds) {
                const blockRootId = await getBlockRootId(blockId);
                if (blockRootId && blockRootId !== currentParentDocId) {
                    console.log(`[${PLUGIN_NAME}]`, `syncSubDocToTargetParent(${source}) tree-catchup`, {
                        subDocId,
                        currentParentDocId,
                        blockRootId,
                    });
                    this.logEvent("sync-parent.tree-catchup", {
                        source,
                        subDocId,
                        currentParentDocId,
                        blockRootId,
                    });
                    await this.moveSubDocBlockToDoc(subDocId, currentParentDocId, `${source}-tree-catchup`);
                    return;
                }
            }
        }

        console.log(`[${PLUGIN_NAME}]`, `syncSubDocToTargetParent(${source})`, { subDocId, targetParentDocId });
        this.markSubDocMoving(subDocId);
        await this.moveSubDocToParent(subDocId, targetParentDocId, source);
    }

    async syncSubDocParentForBlock(blockId, op, source) {
        if (!blockId) {
            return;
        }

        let subDocId = extractSubDocIdFromOpData(op?.data || op?.Data);
        if (!subDocId && this.blockToSubDoc.has(blockId)) {
            subDocId = this.blockToSubDoc.get(blockId);
        }
        if (!subDocId) {
            const binding = await getDocBlockBindingFromBlockId(blockId);
            if (!binding?.subDocId) {
                return;
            }
            subDocId = binding.subDocId;
        }

        let targetDocId = await resolveTargetDocIdForOp(op, blockId, this);
        if (!targetDocId) {
            targetDocId = await getBlockRootId(blockId);
        }
        if (!targetDocId || targetDocId === subDocId) {
            return;
        }

        const binding = await getDocBlockBindingFromBlockId(blockId);
        if (!binding || binding.subDocId !== subDocId) {
            return;
        }
        this.rememberBlockSubDoc(blockId, subDocId);

        const currentParentDocId = await resolveParentDocIdFromSql(subDocId);
        const opAction = getOpAction(op || {});
        if (currentParentDocId && currentParentDocId === targetDocId && opAction === "move") {
            this.markRecentDocMove(subDocId, targetDocId);
            return;
        }

        const syncSubDocId = subDocId;
        const syncTargetDocId = targetDocId;
        const syncSource = source;
        await this.enqueueSubDocSync(syncSubDocId, () =>
            this.syncSubDocToTargetParent(syncSubDocId, syncTargetDocId, syncSource),
        );
    }

    async ensureSubDocForBlock(blockId, preferredSubDocId, source) {
        if (!blockId || this.pendingBlockCreates.has(blockId)) {
            return;
        }

        const attrs = await getBlockAttrs(blockId, { preferSql: true, skipWait: true });
        const isDocBlock = attrs?.[ATTR_BLOCK] === "1";
        if (!isDocBlock) {
            return;
        }

        let subDocId = preferredSubDocId || attrs?.[ATTR_DOC_ID];
        const existingDoc = subDocId ? await getDocumentRow(subDocId) : null;
        if (existingDoc) {
            const canonicalBlockId = await getDocBlockIdFromDoc(subDocId);
            if (canonicalBlockId && canonicalBlockId !== blockId) {
                if (isDocBlock && attrs?.[ATTR_DOC_ID] === subDocId) {
                    this.rememberBlockSubDoc(blockId, subDocId);
                    if (await this.isSubDocInTrash(subDocId)) {
                        const parentDocId = await getBlockRootId(blockId);
                        this.scheduleDocMove(subDocId, "restore", { blockId, parentDocId, source });
                    }
                    return;
                }
                await this.convertBlockToDocRef(blockId, subDocId, `${source}-dup`);
                return;
            }
            if (await this.isSubDocInTrash(subDocId)) {
                const parentDocId = await getBlockRootId(blockId);
                this.scheduleDocMove(subDocId, "restore", { blockId, parentDocId, source });
                return;
            }
            await writeDocBlockBinding(blockId, subDocId);
            this.rememberBlockSubDoc(blockId, subDocId);
            await this.syncSubDocParentForBlock(blockId, null, `${source}-existing-doc`);
            await this.syncSubDocBlockTitle(subDocId, existingDoc.content, source);
            decorateSubDocBlocks(document, this);
            return;
        }

        const parentDocId = await getBlockRootId(blockId);
        if (!parentDocId) {
            return;
        }

        this.pendingBlockCreates.add(blockId);
        try {
            const title = cleanTitle((await fetchSyncPost("/api/block/getBlockKramdown", { id: blockId })).data?.kramdown) || "未命名";
            subDocId = await this.createSubDocUnderParent(parentDocId, title, subDocId || null);
            if (!subDocId) {
                return;
            }
            await this.syncSubDocBlockTitle(subDocId, title, source);
            const bound = await writeDocBlockBinding(blockId, subDocId);
            if (bound) {
                this.rememberBlockSubDoc(blockId, subDocId);
            }
            decorateSubDocBlocks(document, this);
            console.log(`[${PLUGIN_NAME}]`, `ensureSubDocForBlock(${source})`, { blockId, subDocId, parentDocId });
        } finally {
            this.pendingBlockCreates.delete(blockId);
        }
    }

    async moveSubDocToParent(subDocId, targetParentDocId, source) {
        if (!subDocId || !targetParentDocId || subDocId === targetParentDocId) {
            return;
        }
        const targetRow = await getDocumentRow(targetParentDocId);
        if (!targetRow) {
            console.warn(`[${PLUGIN_NAME}]`, `moveSubDocToParent(${source}) invalid target`, targetParentDocId);
            return;
        }
        this.markSubDocMoving(subDocId);
        const response = await fetchSyncPost("/api/filetree/moveDocsByID", {
            fromIDs: [subDocId],
            toID: targetParentDocId,
        });
        this.logEvent("doc-move.to-parent", {
            source,
            subDocId,
            targetParentDocId,
            code: response.code,
            msg: response.msg,
        });
        console.log(`[${PLUGIN_NAME}]`, `moveSubDocToParent(${source})`, { subDocId, targetParentDocId }, response);
        if (response.code !== 0) {
            showMessage(`${this.i18n.moveDocFailed}: ${response.msg}`);
        }
    }

    async moveSubDocBlockToDoc(subDocId, targetParentDocId, source) {
        if (!subDocId || !targetParentDocId) {
            return false;
        }
        if (this.movingBlocksForDoc.has(subDocId)) {
            await sleep(200);
        }
        this.movingBlocksForDoc.add(subDocId);
        try {
            const blockIds = await findSubDocBlockIds(subDocId);
            if (blockIds.length === 0) {
                return false;
            }

            let previousID = await getLastBlockIdInDoc(targetParentDocId, blockIds);
            let moved = false;
            for (const blockId of blockIds) {
                if (!(await isBlockRowPresent(blockId))) {
                    continue;
                }
                const payload = { id: blockId };
                if (previousID && previousID !== blockId) {
                    payload.previousID = previousID;
                } else {
                    payload.parentID = targetParentDocId;
                }
                let response = null;
                for (let attempt = 0; attempt < 3; attempt++) {
                    response = await fetchSyncPost("/api/block/moveBlock", payload);
                    if (response.code === 0) {
                        break;
                    }
                    if (attempt < 2) {
                        await sleep(150 * (attempt + 1));
                    }
                }
                this.logEvent("block-move.to-parent", {
                    source,
                    subDocId,
                    blockId,
                    targetParentDocId,
                    payload: safeSerialize(payload),
                    code: response?.code,
                    msg: response?.msg,
                });
                console.log(`[${PLUGIN_NAME}]`, `moveSubDocBlockToDoc(${source})`, payload, response);
                if (response?.code === 0) {
                    moved = true;
                    previousID = blockId;
                    this.rememberBlockSubDoc(blockId, subDocId);
                } else {
                    showMessage(`${this.i18n.moveBlockFailed}: ${response?.msg || "unknown"}`);
                }
            }
            return moved;
        } finally {
            window.setTimeout(() => this.movingBlocksForDoc.delete(subDocId), 300);
        }
    }

    async shouldSkipRecentDocMove(subDocId, targetParentDocId) {
        const key = `${subDocId}::${targetParentDocId}`;
        const now = Date.now();
        const last = this.recentDocMoveKeys.get(key);
        if (!last || now - last >= MOVE_DEDUPE_MS) {
            return false;
        }
        if (targetParentDocId === NOTEBOOK_ROOT_MOVE_KEY) {
            return true;
        }
        return await areDocBlocksInDoc(subDocId, targetParentDocId);
    }

    markRecentDocMove(subDocId, targetParentDocId) {
        const key = `${subDocId}::${targetParentDocId}`;
        this.recentDocMoveKeys.set(key, Date.now());
    }

    shouldSkipRecentMoveEvent(signature, source) {
        if (!signature) {
            return false;
        }
        const now = Date.now();
        const record = this.recentMoveEventKeys.get(signature);
        if (!record) {
            return false;
        }
        const lastAt = record.at || 0;
        if (now - lastAt >= MOVE_DEDUPE_MS) {
            return false;
        }
        // 仅跳过跨通道重复（fetch 与 ws-main），同源事件留给子文档去重处理。
        return record.source && source && record.source !== source;
    }

    markRecentMoveEvent(signature, source) {
        if (!signature) {
            return;
        }
        this.pruneRecentMoveEventKeys();
        this.recentMoveEventKeys.set(signature, {
            source: source || "unknown",
            at: Date.now(),
        });
    }

    async handleDocMove(moveInfo, source) {
        this.logEvent("doc-move.handle", {
            source,
            byId: !!moveInfo?.byId,
            fromIDs: safeSerialize(moveInfo?.fromIDs || []),
            fromPaths: safeSerialize(moveInfo?.fromPaths || []),
            toID: moveInfo?.toID || null,
            toPath: moveInfo?.toPath || null,
            toNotebook: moveInfo?.toNotebook || null,
        });
        const signature = buildMoveEventSignature(moveInfo);
        if (this.shouldSkipRecentMoveEvent(signature, source)) {
            console.log(`[${PLUGIN_NAME}]`, `handleDocMove(${source}) skip duplicate event`, { signature });
            this.logEvent("doc-move.handle.skip-duplicate", { source, signature });
            return;
        }
        this.markRecentMoveEvent(signature, source);

        let movedSubDocIds = [];
        if (moveInfo.byId && Array.isArray(moveInfo.fromIDs)) {
            movedSubDocIds = moveInfo.fromIDs;
        } else if (Array.isArray(moveInfo.fromPaths)) {
            movedSubDocIds = moveInfo.fromPaths
                .map((entry) => docIdFromFromPathEntry(entry))
                .filter(Boolean);
        }

        const tasks = movedSubDocIds.map((subDocId) =>
            this.enqueueSubDocSync(subDocId, () => this.handleDocMoveForSubDoc(subDocId, moveInfo, source)),
        );
        await Promise.all(tasks);
    }

    async handleDocMoveForSubDoc(subDocId, moveInfo, source) {
        if (!subDocId || !(await isDocumentPresent(subDocId))) {
            return;
        }
        this.logEvent("doc-move.handle.subdoc.start", { source, subDocId });

        if (isSelfDocTreeMove(subDocId, moveInfo)) {
            console.log(`[${PLUGIN_NAME}]`, `handleDocMove(${source}) skip self-move`, { subDocId, moveInfo });
            return;
        }

        const targetParentDocId = await resolveMoveTargetParentDocId(moveInfo, subDocId, this);
        if (!targetParentDocId || targetParentDocId === subDocId) {
            if (await isSubDocAtNotebookRoot(subDocId)) {
                if (!(await this.isPluginManagedSubDoc(subDocId))) {
                    return;
                }
                if (await this.shouldSkipRecentDocMove(subDocId, NOTEBOOK_ROOT_MOVE_KEY)) {
                    return;
                }
                this.markRecentDocMove(subDocId, NOTEBOOK_ROOT_MOVE_KEY);
                await this.removeSubDocBlocksOnRootMove(subDocId, source);
                return;
            }
            console.warn(`[${PLUGIN_NAME}]`, `handleDocMove(${source}) missing target`, { subDocId, moveInfo });
            this.logEvent("doc-move.handle.subdoc.missing-target", { source, subDocId });
            return;
        }

        const trashNotebook = await this.resolveTrashNotebook();
        if (trashNotebook && targetParentDocId === trashNotebook.id) {
            return;
        }

        if (this.movingSubDocIds.has(subDocId) || this.movingBlocksForDoc.has(subDocId)) {
            if (await areDocBlocksInDoc(subDocId, targetParentDocId)) {
                return;
            }
            await sleep(250);
            if (await areDocBlocksInDoc(subDocId, targetParentDocId)) {
                return;
            }
            console.log(`[${PLUGIN_NAME}]`, `handleDocMove(${source}) retry after in-flight`, { subDocId });
            this.logEvent("doc-move.handle.subdoc.retry-inflight", { source, subDocId });
        }

        const blockIds = await findSubDocBlockIds(subDocId);
        const isNestedChildMove = blockIds.length === 0 && (await resolveParentDocIdFromSql(subDocId));
        if (blockIds.length === 0 && !isNestedChildMove && !(await this.isPluginManagedSubDoc(subDocId))) {
            return;
        }

        await flushSqlTransaction();
        const currentParentDocId = await resolveParentDocIdFromSql(subDocId);
        if (currentParentDocId === targetParentDocId && await areDocBlocksInDoc(subDocId, targetParentDocId)) {
            return;
        }

        if (await this.shouldSkipRecentDocMove(subDocId, targetParentDocId)) {
            return;
        }

        console.log(`[${PLUGIN_NAME}]`, `handleDocMove(${source})`, { subDocId, targetParentDocId, blockIds });
        this.logEvent("doc-move.handle.subdoc.target", {
            source,
            subDocId,
            targetParentDocId,
            blockCount: blockIds.length,
        });

        if (blockIds.length === 0) {
            const title = await getDocTitle(subDocId);
            this.scheduleBindSubDocBlock(targetParentDocId, subDocId, `${source}-move-bind`, title);
            this.markRecentDocMove(subDocId, targetParentDocId);
            this.clearDocMovePending(subDocId);
            return;
        }

        const moved = await this.moveSubDocBlockToDoc(subDocId, targetParentDocId, source);
        if (moved) {
            this.markRecentDocMove(subDocId, targetParentDocId);
            this.clearDocMovePending(subDocId);
        }
    }

    shouldSkipRecentCreate(parentDocId, subDocId) {
        const key = `${parentDocId}::${subDocId}`;
        const now = Date.now();
        const last = this.recentCreateKeys.get(key);
        if (last && now - last < DEDUPE_MS) {
            console.log(`[${PLUGIN_NAME}]`, "dedupe skip", key);
            return true;
        }
        return false;
    }

    onSubDocCreated(subDocId, parentDocId, source, titleHint = null) {
        if (!subDocId || !parentDocId || parentDocId === subDocId) {
            return;
        }
        if (this.shouldSkipPluginInitiatedCreate(parentDocId, subDocId)) {
            console.log(`[${PLUGIN_NAME}]`, "onSubDocCreated skip plugin-initiated", { subDocId, parentDocId, source });
            return;
        }
        if (this.shouldSkipRecentCreate(parentDocId, subDocId)) {
            console.log(`[${PLUGIN_NAME}]`, "onSubDocCreated skip recent create", { subDocId, parentDocId, source });
            return;
        }
        console.log(`[${PLUGIN_NAME}]`, "onSubDocCreated", { subDocId, parentDocId, source });
        this.scheduleBindSubDocBlock(parentDocId, subDocId, source, titleHint);
    }

    scheduleBindSubDocBlock(parentDocId, subDocId, source, titleHint = null, triggerBlockId = null) {
        if (!subDocId || !parentDocId || this.insertingSubDocBlocks.has(subDocId)) {
            return;
        }
        this.logEvent("bind.schedule", { parentDocId, subDocId, source, triggerBlockId });
        this.bindSubDocBlock(parentDocId, subDocId, source, titleHint, triggerBlockId).catch((error) => {
            console.warn(`[${PLUGIN_NAME}]`, "bindSubDocBlock failed", error);
        });
    }

    /**
     * 所有"确保 subDocId 在 parentDocId 下有对应文档块"的入口都必须走这里——无论是
     * ws-create 广播触发的 onSubDocCreated，还是复制/剪切粘贴逻辑直接发起绑定。
     *
     * 背景（v1.10.21 复制粘贴仍报 invalid data tree 的根因）：
     * 之前 clipboard-paste 路径直接 `await this.bindSubDocBlock(...)`，绕过了
     * scheduleBindSubDocBlock 里的 insertingSubDocBlocks 互斥锁；而 createDoc 调用一旦
     * 返回，内核会广播 ws-main "create" 事件，触发 onSubDocCreated 走 scheduleBindSubDocBlock
     * 再次绑定同一个 subDocId。两条路径并发执行，各自为同一个新文档创建了一个文档块，
     * 从日志上看两次 bind.append.done 产生了两个不同的 blockId，SiYuan 内核随即报 txerr /
     * invalid data tree。
     *
     * 修复：把互斥锁下沉到 bindSubDocBlock 内部（唯一入口），并用 Promise 缓存让后来者
     * 复用同一次绑定结果，而不是各自发起一次绑定。
     */
    bindSubDocBlock(parentDocId, subDocId, source, titleHint = null, triggerBlockId = null) {
        if (!subDocId || !parentDocId || parentDocId === subDocId) {
            return Promise.resolve(false);
        }
        const existingPromise = this.bindSubDocBlockPromises.get(subDocId);
        if (existingPromise) {
            this.logEvent("bind.join-inflight", { parentDocId, subDocId, source, triggerBlockId });
            return existingPromise;
        }
        this.insertingSubDocBlocks.add(subDocId);
        const promise = this._bindSubDocBlockImpl(parentDocId, subDocId, source, titleHint, triggerBlockId)
            .catch((error) => {
                console.warn(`[${PLUGIN_NAME}]`, "bindSubDocBlock failed", error);
                return false;
            })
            .finally(() => {
                this.insertingSubDocBlocks.delete(subDocId);
                this.bindSubDocBlockPromises.delete(subDocId);
            });
        this.bindSubDocBlockPromises.set(subDocId, promise);
        return promise;
    }

    async _bindSubDocBlockImpl(parentDocId, subDocId, source, titleHint = null, triggerBlockId = null) {
        this.logEvent("bind.start", { parentDocId, subDocId, source, triggerBlockId });
        console.log(`[${PLUGIN_NAME}]`, `bindSubDocBlock(${source})`, { parentDocId, subDocId, triggerBlockId });

        await flushSqlTransaction();

        if (this.shouldSkipRecentCreate(parentDocId, subDocId)) {
            const existingAfterDedupe = await findSubDocBlockIds(subDocId);
            if (existingAfterDedupe.length > 0) {
                return true;
            }
        }

        const existing = await findSubDocBlockIds(subDocId);
        if (existing.length > 0) {
            console.log(`[${PLUGIN_NAME}]`, `bindSubDocBlock(${source}) block exists`, existing);
            this.markRecentCreate(parentDocId, subDocId);
            this.logEvent("bind.skip-existing", { parentDocId, subDocId, source, existingCount: existing.length });
            return true;
        }

        let title = cleanTitle(titleHint);
        if (!title) {
            const docRow = await getDocumentRow(subDocId);
            title = cleanTitle(docRow?.content);
        }
        title = title || "未命名";

        let effectiveTriggerId = triggerBlockId;
        if (!effectiveTriggerId && this.pendingTriggerBind?.parentDocId === parentDocId) {
            effectiveTriggerId = this.pendingTriggerBind.triggerBlockId;
        }

        if (effectiveTriggerId && effectiveTriggerId !== parentDocId) {
            if (shouldReplaceTriggerBlock(source)) {
                const replaced = await this.replaceTriggerBlockWithSubDoc(
                    effectiveTriggerId, parentDocId, subDocId, source, title,
                );
                if (replaced) {
                    if (this.pendingTriggerBind?.parentDocId === parentDocId) {
                        this.pendingTriggerBind = null;
                    }
                    return true;
                }
                this.logEvent("bind.replace-trigger.fallback-insert-after", {
                    parentDocId, subDocId, source, triggerBlockId: effectiveTriggerId,
                });
            }
            return this.insertSubDocBlockAfter(effectiveTriggerId, parentDocId, subDocId, source, title);
        }

        return this.appendSubDocBlockAtParentEnd(parentDocId, subDocId, source, title);
    }

    async insertSubDocBlockAfter(afterBlockId, parentDocId, subDocId, source, title) {
        this.logEvent("bind.insert-after.start", { afterBlockId, parentDocId, subDocId, source, title });
        if (!afterBlockId || !(await isBlockRowPresent(afterBlockId))) {
            return this.appendSubDocBlockAtParentEnd(parentDocId, subDocId, source, title);
        }
        const markdown = await buildSubDocBlockMarkdown(subDocId, title, getDocBlockHeadingLevel(this));
        const response = await fetchSyncPost("/api/block/insertBlock", {
            dataType: "markdown",
            data: markdown,
            previousID: afterBlockId,
        });
        if (response.code !== 0) {
            this.logEvent("bind.insert-after.failed", {
                afterBlockId, parentDocId, subDocId, source, code: response.code, msg: response.msg,
            });
            return this.appendSubDocBlockAtParentEnd(parentDocId, subDocId, source, title);
        }
        const blockId = extractNewBlockId(response);
        if (!blockId || blockId === subDocId) {
            this.logEvent("bind.insert-after.failed-invalid-block-id", { afterBlockId, parentDocId, subDocId, source, blockId });
            return false;
        }
        this.markRecentCreate(parentDocId, subDocId);
        this.rememberBlockSubDoc(blockId, subDocId);
        const bound = await finalizeDocBlockPresentation(this, blockId, subDocId);
        if (!bound) {
            this.logEvent("bind.insert-after.failed-binding", { afterBlockId, parentDocId, subDocId, source, blockId });
            return false;
        }
        this.logEvent("bind.insert-after.done", { afterBlockId, parentDocId, subDocId, source, blockId });
        return true;
    }

    async appendSubDocBlockAtParentEnd(parentDocId, subDocId, source, title) {
        this.logEvent("bind.append.start", { parentDocId, subDocId, source, title });
        console.log(`[${PLUGIN_NAME}]`, `appendSubDocBlockAtParentEnd(${source})`, { parentDocId, subDocId, title });

        const parentRow = await getDocumentRow(parentDocId);
        if (!parentRow) {
            console.warn(`[${PLUGIN_NAME}]`, `appendSubDocBlockAtParentEnd(${source}) parent not found`, parentDocId);
            return false;
        }

        const markdown = await buildSubDocBlockMarkdown(subDocId, title, getDocBlockHeadingLevel(this));
        const response = await fetchSyncPost("/api/block/appendBlock", {
            dataType: "markdown",
            data: markdown,
            parentID: parentDocId,
        });
        console.log(`[${PLUGIN_NAME}]`, `appendSubDocBlockAtParentEnd(${source}) result`, response);

        if (response.code !== 0) {
            this.logEvent("bind.append.failed", { parentDocId, subDocId, source, code: response.code, msg: response.msg });
            showMessage(`${this.i18n.createBlockFailed}: ${response.msg}`);
            return false;
        }

        const blockId = extractNewBlockId(response);
        if (!blockId || blockId === subDocId) {
            this.logEvent("bind.append.failed-invalid-block-id", { parentDocId, subDocId, source, blockId });
            return false;
        }

        this.markRecentCreate(parentDocId, subDocId);
        this.rememberBlockSubDoc(blockId, subDocId);
        const bound = await finalizeDocBlockPresentation(this, blockId, subDocId);
        if (!bound) {
            console.warn(`[${PLUGIN_NAME}]`, `appendSubDocBlockAtParentEnd(${source}) write binding failed`, { blockId, subDocId });
            this.logEvent("bind.append.failed-binding", { parentDocId, subDocId, source, blockId });
            return false;
        }
        console.log(`[${PLUGIN_NAME}]`, "appendSubDocBlockAtParentEnd ready", { blockId, subDocId, parentDocId });
        this.logEvent("bind.append.done", { parentDocId, subDocId, source, blockId });
        return true;
    }

    async insertSubDocBlockAtParentEnd(parentDocId, subDocId, source, titleHint = null) {
        return this.bindSubDocBlock(parentDocId, subDocId, source, titleHint);
    }

    markRecentCreate(parentDocId, subDocId) {
        const key = `${parentDocId}::${subDocId}`;
        this.recentCreateKeys.set(key, Date.now());
    }

    extractCreateIds(requestBody, responsePayload) {
        let subDocId = null;
        let parentDocId = requestBody?.parentID || null;
        let title = cleanTitle(requestBody?.title);

        const data = responsePayload?.data;
        if (typeof data === "string") {
            subDocId = data;
        } else if (data?.id) {
            subDocId = data.id;
        }

        if (requestBody?.path && String(requestBody.path).includes(".sy")) {
            const parsed = parseIdsFromStoragePath(requestBody.path);
            if (parsed.subDocId) {
                subDocId = subDocId || parsed.subDocId;
            }
            parentDocId = parentDocId || parsed.parentDocId;
        }

        return { subDocId, parentDocId, title };
    }

    handleCreateFromApi(requestBody, responsePayload, source) {
        const { subDocId, parentDocId: parsedParent, title } = this.extractCreateIds(requestBody, responsePayload);
        const run = async () => {
            let parentDocId = parsedParent;
            if (subDocId && !parentDocId) {
                await flushSqlTransaction();
                parentDocId = await resolveParentDocIdFromSql(subDocId);
            }
            console.log(`[${PLUGIN_NAME}]`, `handleCreateFromApi(${source})`, {
                subDocId,
                parentDocId,
                path: requestBody?.path,
            });
            this.onSubDocCreated(subDocId, parentDocId, source, title);
        };
        run().catch((error) => {
            console.warn(`[${PLUGIN_NAME}]`, `handleCreateFromApi(${source}) failed`, error);
        });
    }

    async removeLinkedSubDoc(subDocId, source) {
        this.scheduleDocMove(subDocId, "trash", { source });
    }

    scheduleSubDocBlockTitleSync(subDocId, title, source) {
        const cleaned = cleanTitle(title);
        if (!subDocId || !cleaned) {
            return;
        }
        this.pendingTitleSync.set(subDocId, cleaned);
        const existing = this.titleSyncTimers.get(subDocId);
        if (existing) {
            window.clearTimeout(existing);
        }
        const timer = window.setTimeout(() => {
            this.titleSyncTimers.delete(subDocId);
            const latest = this.pendingTitleSync.get(subDocId) || cleaned;
            this.pendingTitleSync.delete(subDocId);
            this.syncSubDocBlockTitleImpl(subDocId, latest, source).catch((error) => {
                console.warn(`[${PLUGIN_NAME}]`, `syncSubDocBlockTitle(${source}) failed`, error);
            });
        }, TITLE_SYNC_DEBOUNCE_MS);
        this.titleSyncTimers.set(subDocId, timer);
    }

    async syncSubDocBlockTitle(subDocId, title, source) {
        this.scheduleSubDocBlockTitleSync(subDocId, title, source);
    }

    async syncSubDocBlockTitleImpl(subDocId, title, source) {
        const cleaned = cleanTitle(title);
        if (!subDocId || !cleaned) {
            return;
        }
        if (this.lastSyncedBlockTitles.get(subDocId) === cleaned) {
            return;
        }
        if (!(await isDocumentPresent(subDocId))) {
            return;
        }
        const blockIds = await this.resolveDocBlockIds(subDocId);
        if (blockIds.length === 0) {
            this.pendingTitleSync.set(subDocId, cleaned);
            console.log(`[${PLUGIN_NAME}]`, `syncSubDocBlockTitle(${source}) defer: no blocks yet`, subDocId);
            return;
        }
        blockIds.forEach((blockId) => this.rememberBlockSubDoc(blockId, subDocId));
        console.log(`[${PLUGIN_NAME}]`, `syncSubDocBlockTitle(${source})`, { subDocId, title: cleaned, blockIds });
        let synced = false;
        for (const blockId of blockIds) {
            if (this.pendingBlockCreates.has(blockId)) {
                continue;
            }
            if (!(await isBlockRowPresent(blockId))) {
                continue;
            }
            const markdown = await buildSubDocBlockMarkdownForBlock(
                subDocId, cleaned, getDocBlockHeadingLevel(this), blockId,
            );
            const response = await fetchSyncPost("/api/block/updateBlock", {
                id: blockId,
                dataType: "markdown",
                data: markdown,
            });
            console.log(`[${PLUGIN_NAME}]`, `updateBlock(${source})`, blockId, response);
            if (response.code === 0) {
                synced = true;
                await finalizeDocBlockPresentation(this, blockId, subDocId);
            }
        }
        if (synced) {
            this.lastSyncedBlockTitles.set(subDocId, cleaned);
        }
    }

    patchFetch() {
        if (window.__subDocBlockFetchPatched) {
            return;
        }
        window.__subDocBlockFetchPatched = true;
        this.originalFetch = window.fetch.bind(window);
        const plugin = this;

        window.fetch = async (input, init) => {
            const url = typeof input === "string" ? input : input?.url || "";
            let body = null;
            let ctx = null;

            if (init?.body && typeof init.body === "string") {
                try {
                    body = JSON.parse(init.body);
                    ctx = await prepareApiContext(url, body, plugin);
                    plugin.logEvent("fetch.capture", {
                        url,
                        hasContext: !!ctx,
                        bodyKeys: body && typeof body === "object" ? Object.keys(body) : [],
                    });
                    if (url.includes("/api/transactions") && body?.transactions) {
                        const opSummary = summarizeTransactionOps(body.transactions);
                        plugin.logEvent("fetch.transactions.submit", {
                            opCount: opSummary.length,
                            emptyIdOps: opSummary.filter((op) => op.hasEmptyId).length,
                            ops: opSummary.slice(0, 12),
                        });
                    }
                } catch (error) {
                    console.warn(`[${PLUGIN_NAME}]`, "parse fetch body failed", error);
                }
            }

            const response = await plugin.originalFetch(input, init);

            if (ctx?.create) {
                response.clone().json().then((payload) => {
                    if (payload?.code !== 0) {
                        console.warn(`[${PLUGIN_NAME}]`, "create API failed", payload);
                        plugin.logEvent("fetch.create.failed", { url, code: payload?.code, msg: payload?.msg });
                        return;
                    }
                    plugin.logEvent("fetch.create.success", { url, code: payload?.code || 0 });
                    plugin.handleCreateFromApi(ctx.create.body, payload, ctx.create.source);
                }).catch((error) => {
                    console.warn(`[${PLUGIN_NAME}]`, "read create response failed", error);
                });
            }

            if (shouldApplyApiContext(url, ctx)) {
                response.clone().json().then(async (payload) => {
                    if (payload?.code !== 0) {
                        plugin.logEvent("fetch.apply-context.skip-non-zero", { url, code: payload?.code, msg: payload?.msg });
                        return;
                    }
                    plugin.logEvent("fetch.apply-context", { url, code: payload?.code || 0 });
                    await applyApiContext(ctx, plugin, "fetch");
                }).catch(() => {});
            }

            return response;
        };

        console.log(`[${PLUGIN_NAME}]`, "window.fetch patched");
    }

    onunload() {
        this.logEvent("plugin.onunload.start");
        for (const subDocId of [...this.docMovePending.keys()]) {
            this.clearDocMovePending(subDocId);
        }
        this.subDocSyncChains.clear();
        this.recentMoveEventKeys.clear();
        this.parentSyncChains.clear();
        for (const timer of this.parentReconcileTimers.values()) {
            window.clearTimeout(timer);
        }
        this.parentReconcileTimers.clear();
        if (this.cacheRefreshTimer) {
            window.clearTimeout(this.cacheRefreshTimer);
            this.cacheRefreshTimer = null;
        }
        clearDocClipboardState();
        if (this.wsHandler) {
            this.eventBus.off("ws-main", this.wsHandler);
            this.wsHandler = null;
        }
        if (this.protyleLoadHandler) {
            this.eventBus.off("loaded-protyle-dynamic", this.protyleLoadHandler);
            this.eventBus.off("loaded-protyle-static", this.protyleLoadHandler);
            this.protyleLoadHandler = null;
        }
        if (this.pasteHandler) {
            this.eventBus.off("paste", this.pasteHandler);
            this.pasteHandler = null;
        }
        if (this.copyCaptureHandler) {
            document.removeEventListener("copy", this.copyCaptureHandler, true);
            document.removeEventListener("cut", this.copyCaptureHandler, true);
            this.copyCaptureHandler = null;
        }
        if (this.protyleChangeHandler) {
            this.eventBus.off("protyle-change", this.protyleChangeHandler);
            this.protyleChangeHandler = null;
        }
        if (this.docBlockKeydownHandler) {
            document.removeEventListener("keydown", this.docBlockKeydownHandler, true);
            this.docBlockKeydownHandler = null;
        }
        for (const timer of this.repairDocBlockTimers.values()) {
            window.clearTimeout(timer);
        }
        this.repairDocBlockTimers.clear();
        document.getElementById(STYLE_ID)?.remove();
        if (window.__subDocBlockFetchPatched && this.originalFetch) {
            window.fetch = this.originalFetch;
            window.__subDocBlockFetchPatched = false;
        }
        this.logEvent("plugin.onunload.done");
        this.uninstallConsoleMirror();
        console.log(`${PLUGIN_NAME} 插件已卸载`);
    }
};
