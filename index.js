const { Plugin, Setting, fetchSyncPost, showMessage, openTab, getAllEditor, getModelByDockType } = require("siyuan");

/**
 * sub-doc-block 架构（绑定线 vs 块内容）
 * - 绑定线：删块 → scheduleDocMove(trash)；撤销 insert 且子文档在回收站 → scheduleDocMove(restore)。
 *   DOC_MOVE_DEBOUNCE_MS 只用于子文档 moveDocsByID，不改块 markdown。
 * - 块内容：创建/补块时一次文档块 markdown + setDocBlockAttrs；重命名走 syncSubDocBlockTitle。
 *   文档块判定：Properties 同时含 custom-doc-block=1 与 custom-doc-id；引用块仅 block-ref。
 *   粘贴仅块引，不升级 custom-doc-block。decorateSubDocBlocks 只加 CSS class。
 */
const PLUGIN_NAME = "sub-doc-block";
const ATTR_BLOCK = "custom-doc-block";
const ATTR_DOC_ID = "custom-doc-id";
const ATTR_DOC_BLOCK_ID = "custom-doc-block-id";
const STYLE_ID = "plugin-doc-block-style";
const DEFAULT_DOC_ICON_EMOJI = "\u{1F4C4}";
const TRASH_NOTEBOOK_NAME = "文档回收";
const CONFIG_STORAGE = "config.json";
const DEFAULT_CONFIG = {
    docBlockHeadingLevel: 5,
    fileTreeClickToggle: true,
    autoClearTrashOnStartup: false,
};
const DEDUPE_MS = 5000;
const SYNC_DEDUPE_MS = 800;
/** 删块/撤块后移动子文档（进/出「文档回收」）的去抖；不修改块内容 */
const DOC_MOVE_DEBOUNCE_MS = 800;
const DELETE_GUARD_MS = 5000;
const MOVE_GUARD_MS = 5000;
const NOTEBOOK_ROOT_MOVE_KEY = "__notebook_root__";
const WS_LOG_CMDS = new Set(["create", "removeDoc", "rename", "savedoc", "transactions", "moveDoc"]);
const DOC_BLOCK_LABELS = "(?:文档块|文档|Document block|Document|Doc)";
const DOC_BLOCK_HEADING_MD = "(?:#{1,6}\\s+)?";

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

async function resolveSlashProtyleContext(protyle, nodeElement) {
    const triggerBlockId = resolveSlashTriggerBlockId(protyle, nodeElement);

    let block = protyle?.block
        || protyle?.protyle?.block
        || protyle?.getInstance?.()?.block
        || null;

    if (!block && nodeElement) {
        const editors = getAllEditor();
        const hostEditor = editors.find((editor) => editor?.protyle?.element?.contains?.(nodeElement));
        block = hostEditor?.protyle?.block || null;
    }

    if (!block) {
        const activeEditor = getAllEditor()[0];
        block = activeEditor?.protyle?.block || null;
    }

    const blockId = triggerBlockId || block?.id || null;

    let rootDocId = block?.rootID || block?.rootId || null;
    if (!rootDocId && blockId) {
        rootDocId = await getBlockRootId(blockId);
    }

    return { block, blockId, rootDocId };
}

function resolveSlashTriggerBlockId(protyle, nodeElement) {
    if (nodeElement) {
        const fromNode = nodeElement.getAttribute?.("data-node-id")
            || nodeElement.closest?.("[data-node-id]")?.getAttribute("data-node-id");
        if (fromNode) {
            return fromNode;
        }
    }
    return protyle?.block?.id
        || protyle?.getInstance?.()?.block?.id
        || null;
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

function getDocBlockContentScope(blockEl) {
    return blockEl?.querySelector('[contenteditable="true"]') || blockEl;
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
    if (blockEl.querySelector("[data-sub-doc-readonly]")) {
        return false;
    }
    if (docBlockHasBrokenChipMarkup(blockEl)) {
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
    if (blockEl.querySelector("[data-sub-doc-readonly]")) {
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
        textHTML: "",
        siyuanHTML: "",
    };
}

const SIYUAN_CLIPBOARD_ZWSP = "\u200b";

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

function handleCopyCapture(event) {
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
        return;
    }
    const protyle = getProtyleFromWysiwyg(wysiwyg);
    const onlyDocBlocks = !selectionHasNonDocBlocks(wysiwyg)
        && selected.length > 0
        && selected.every((blockEl) => isDocBlockLikeElement(blockEl));

    if (event.type === "copy") {
        if (onlyDocBlocks) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            writeDocRefsToClipboardData(event, refs, protyle);
            console.log(`[${PLUGIN_NAME}]`, "copy as doc ref", refs);
            return;
        }
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
        scheduleRewriteClipboardAsDocRefs(refs);
        console.log(`[${PLUGIN_NAME}]`, "cut clipboard rewrite as doc ref", refs);
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
${buildDocBlockStyleSelectors(" > div[contenteditable]")} {
    display: inline;
    background-color: var(--b3-protyle-code-background);
    border-radius: var(--b3-border-radius);
    padding: .2em .4em;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
    cursor: pointer;
}
${buildDocBlockStyleSelectors(" span[data-type~=\"block-ref\"]")} {
    font: inherit;
    font-weight: inherit;
    font-size: inherit;
    line-height: inherit;
    color: inherit;
    cursor: pointer;
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
        styleTarget.classList.add("sub-doc-block");
        if (!styleTarget.dataset.subDocBound) {
            styleTarget.dataset.subDocBound = "true";
        }
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

async function getSubDocIdFromBlock(blockId) {
    if (!blockId) {
        return null;
    }

    const sqlAttrs = await queryBlockAttrsFromSql(blockId);
    if (sqlAttrs?.[ATTR_DOC_ID]) {
        return sqlAttrs[ATTR_DOC_ID];
    }

    const domSubDocId = readSubDocIdFromDom(blockId);
    if (domSubDocId) {
        return domSubDocId;
    }

    if (!(await isBlockRowPresent(blockId))) {
        return null;
    }

    const attrs = await getBlockAttrs(blockId, { skipWait: true, preferSql: true });
    if (attrs?.[ATTR_DOC_ID]) {
        return attrs[ATTR_DOC_ID];
    }

    const escapedId = escapeSqlLiteral(blockId);
    const relatedStmt = `
        select a.value as sub_doc_id from attributes a
        where a.name = '${ATTR_DOC_ID}'
        and a.block_id in (
            select id from blocks where id = '${escapedId}'
            union
            select id from blocks where parent_id = '${escapedId}'
            union
            select parent_id from blocks where id = '${escapedId}' and parent_id != ''
        )
        limit 1
    `;
    const relatedSql = await fetchSyncPost("/api/query/sql", { stmt: relatedStmt });
    if (relatedSql.code === 0 && relatedSql.data?.[0]?.sub_doc_id) {
        return relatedSql.data[0].sub_doc_id;
    }

    const ialStmt = `
        select ial from blocks
        where id = '${escapedId}'
           or parent_id = '${escapedId}'
           or id = (select parent_id from blocks where id = '${escapedId}' limit 1)
        limit 5
    `;
    const ialSql = await fetchSyncPost("/api/query/sql", { stmt: ialStmt });
    for (const row of ialSql.data || []) {
        const match = (row.ial || "").match(new RegExp(`"${ATTR_DOC_ID}"\\s*:\\s*"([^"]+)"`));
        if (match?.[1]) {
            return match[1];
        }
    }

    return null;
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

        let subDocId = extractSubDocIdFromOpData(op.data || op.Data);
        if (!subDocId) {
            subDocId = await plugin.resolveSubDocIdForBlock(blockId);
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

    const hints = [];
    if (moveInfo.byId && moveInfo.toID) {
        const hint = await normalizeTargetDocId(moveInfo.toID);
        if (hint) {
            hints.push(hint);
        }
    }
    if (moveInfo.toPath) {
        const hint = await normalizeTargetDocId(resolveTargetFromMoveToPath(moveInfo.toPath));
        if (hint) {
            hints.push(hint);
        }
    }

    for (let i = 0; i < 10; i++) {
        await fetchSyncPost("/api/sqlite/flushTransaction", {});
        const sqlParent = await normalizeTargetDocId(await resolveParentDocIdFromSql(subDocId));
        if (sqlParent) {
            return sqlParent;
        }
        if (i < 9) {
            await sleep(50);
        }
    }

    for (const hint of hints) {
        if (hint) {
            return hint;
        }
    }

    return null;
}

async function applyApiContext(ctx, plugin, source) {
    if (!ctx) {
        return;
    }

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
                continue;
            }
            if (!(await plugin.isCanonicalOwnerBlock(subDocId, blockId))) {
                plugin.forgetBlockSubDoc(blockId);
                continue;
            }
            plugin.scheduleDocMove(subDocId, "trash", { blockId, source: `${source}-delete-block` });
            plugin.forgetBlockSubDoc(blockId);
        }
    }

    if (ctx.rename?.docId && ctx.rename?.title) {
        await plugin.syncSubDocBlockTitle(ctx.rename.docId, ctx.rename.title, source);
    }

    if (ctx.moveDocs) {
        await plugin.handleDocMove(ctx.moveDocs, source);
    }
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
    recentSyncKeys = new Map();
    blockToSubDoc = new Map();
    creatingSubDocForParent = new Set();
    insertingSubDocBlocks = new Set();
    syncingDeleteBlockForDoc = new Set();
    syncingTrashDocForBlock = new Set();
    trashingSubDocIds = new Set();
    movingSubDocIds = new Set();
    movingBlocksForDoc = new Set();
    pendingBlockCreates = new Set();
    pendingTitleSync = new Map();
    slashInProgressForParent = null;
    config = { ...DEFAULT_CONFIG };
    configReady = null;
    setting = null;
    topBarEntry = null;
    clearingTrash = false;

    onload() {
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
            this.refreshBlockSubDocCache("protyle-load").catch((error) => {
                console.warn(`[${PLUGIN_NAME}]`, "refreshBlockSubDocCache failed", error);
            });
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
                handleCopyCapture(event);
            } catch (error) {
                console.warn(`[${PLUGIN_NAME}]`, "handleCopyCapture failed", error);
            }
        };
        document.addEventListener("copy", this.copyCaptureHandler, true);
        document.addEventListener("cut", this.copyCaptureHandler, true);
    }

    handlePasteEvent(event) {
        const detail = event?.detail;
        if (!detail) {
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
        const attrsOk = await setDocBlockAttrs(blockId, docId);
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
        const { rootDocId, blockId: triggerBlockId } = await resolveSlashProtyleContext(protyle, nodeElement);
        if (!rootDocId) {
            console.warn(`[${PLUGIN_NAME}]`, "createSubDocFromSlash: parent doc not found", { protyle, nodeElement });
            showMessage(this.i18n.createDocFailed);
            return;
        }

        clearSlashTextInBlock(nodeElement);
        this.slashInProgressForParent = rootDocId;
        try {
            const title = "未命名";
            const subDocId = await this.createSubDocUnderParent(rootDocId, title);
            if (!subDocId) {
                return;
            }

            if (this.app) {
                openTab({
                    app: this.app,
                    doc: { id: subDocId },
                });
            }

            this.scheduleBindSubDocBlock(rootDocId, subDocId, "slash-create", title, triggerBlockId);
        } finally {
            this.slashInProgressForParent = null;
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
            const parentHPath = await getHPathByDocId(parentDocId);
            if (parentHPath) {
                const childHPath = `${parentHPath.replace(/\/+$/, "")}/${childTitle}`;
                const mdResponse = await fetchSyncPost("/api/filetree/createDocWithMd", {
                    notebook,
                    path: childHPath,
                    markdown: "",
                });
                if (mdResponse.code === 0) {
                    const createdId = typeof mdResponse.data === "string"
                        ? mdResponse.data
                        : mdResponse.data?.id;
                    if (createdId) {
                        return createdId;
                    }
                } else {
                    console.warn(`[${PLUGIN_NAME}]`, "createDocWithMd failed", mdResponse);
                }
            }

            if (!pathInfo?.path) {
                console.warn(`[${PLUGIN_NAME}]`, "createSubDocUnderParent: storage path missing", parentDocId, pathInfo);
                showMessage(this.i18n.createDocFailed);
                return null;
            }

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
            const trashNotebook = await this.resolveTrashNotebook();
            if (!trashNotebook?.id) {
                if (source === "manual") {
                    showMessage(this.i18n.trashNotebookFailed);
                }
                return { deleted: 0, kept: 0 };
            }
            const docIds = await listDocIdsInNotebook(trashNotebook.id);
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
        const notebook = await findNotebookByName(TRASH_NOTEBOOK_NAME);
        this.trashNotebookId = notebook?.id || null;
        return notebook;
    }

    async ensureTrashNotebook() {
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
        let notebook = await findNotebookByName(TRASH_NOTEBOOK_NAME);
        if (notebook?.id) {
            this.trashNotebookId = notebook.id;
            console.log(`[${PLUGIN_NAME}]`, "ensureTrashNotebook found by name", notebook.id);
            return notebook.id;
        }

        console.log(`[${PLUGIN_NAME}]`, "ensureTrashNotebook creating", TRASH_NOTEBOOK_NAME);
        const response = await fetchSyncPost("/api/notebook/createNotebook", {
            name: TRASH_NOTEBOOK_NAME,
            icon: "iconTrashcan",
        });

        notebook = await waitForNotebookByName(TRASH_NOTEBOOK_NAME);
        if (notebook?.id) {
            this.trashNotebookId = notebook.id;
            console.log(`[${PLUGIN_NAME}]`, "ensureTrashNotebook ready", notebook.id, { createCode: response.code });
            return notebook.id;
        }

        if (response.code !== 0) {
            showMessage(`${this.i18n.trashNotebookFailed}: ${response.msg}`);
        } else {
            showMessage(this.i18n.trashNotebookFailed);
        }
        this.trashNotebookId = null;
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
        if (pending.timer) {
            window.clearTimeout(pending.timer);
        }
        pending.timer = window.setTimeout(() => {
            this.flushDocMove(subDocId).catch((error) => {
                console.warn(`[${PLUGIN_NAME}]`, "flushDocMove failed", subDocId, error);
            });
        }, DOC_MOVE_DEBOUNCE_MS);
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

        if (intent === "trash") {
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

    rememberBlockSubDoc(blockId, subDocId) {
        if (blockId && subDocId) {
            this.blockToSubDoc.set(blockId, subDocId);
        }
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
        const subDocId = await getSubDocIdFromBlock(blockId);
        if (subDocId) {
            this.rememberBlockSubDoc(blockId, subDocId);
        }
        return subDocId;
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
        const attrs = await queryBlockAttrsFromSql(blockId);
        if (attrs?.[ATTR_BLOCK] === "1" && attrs?.[ATTR_DOC_ID]) {
            this.rememberBlockSubDoc(blockId, attrs[ATTR_DOC_ID]);
        }
    }

    async handleWsMain(detail) {
        if (!detail?.cmd) {
            return;
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
        for (const tx of transactions) {
            const { deletedSubDocIds, relocated } = await analyzeTransactionSubDocOps(tx, this);
            const ops = tx.doOperations || tx.DoOperations || [];
            const restoringSubDocIds = new Set();

            for (const op of ops) {
                const action = getOpAction(op);
                const blockId = getOpBlockId(op);
                if (!blockId) {
                    continue;
                }

                if (action === "delete") {
                    this.forgetBlockSubDoc(blockId);
                    continue;
                }

                if (action === "move") {
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
                await this.syncSubDocToTargetParent(subDocId, targetDocId, "ws-transactions-relocate");
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
        const currentParentDocId = await resolveParentDocId(subDocId);
        if (!currentParentDocId || currentParentDocId === targetParentDocId) {
            return;
        }
        console.log(`[${PLUGIN_NAME}]`, `syncSubDocToTargetParent(${source})`, { subDocId, targetParentDocId });
        this.markBlockMoving(subDocId);
        await this.moveSubDocToParent(subDocId, targetParentDocId, source);
    }

    async syncSubDocParentForBlock(blockId, op, source) {
        if (!blockId) {
            return;
        }

        let subDocId = extractSubDocIdFromOpData(op?.data || op?.Data);
        if (!subDocId) {
            subDocId = await this.resolveSubDocIdForBlock(blockId);
        }
        if (!subDocId) {
            return;
        }

        let targetDocId = await resolveTargetDocIdForOp(op, blockId, this);
        if (!targetDocId) {
            targetDocId = await getBlockRootId(blockId);
        }
        if (!targetDocId) {
            return;
        }

        const binding = await getDocBlockBindingFromBlockId(blockId);
        if (!binding || binding.subDocId !== subDocId) {
            return;
        }
        this.rememberBlockSubDoc(blockId, subDocId);
        await setDocBlockAttrs(blockId, subDocId);
        await this.syncSubDocToTargetParent(subDocId, targetDocId, source);
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
            await setDocBlockAttrs(blockId, subDocId);
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
            await setDocBlockAttrs(blockId, subDocId);
            this.rememberBlockSubDoc(blockId, subDocId);
            await setDocBlockIdOnDoc(subDocId, blockId);
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
        console.log(`[${PLUGIN_NAME}]`, `moveSubDocToParent(${source})`, { subDocId, targetParentDocId }, response);
        if (response.code !== 0) {
            showMessage(`${this.i18n.moveDocFailed}: ${response.msg}`);
        }
    }

    async moveSubDocBlockToDoc(subDocId, targetParentDocId, source) {
        if (!subDocId || !targetParentDocId) {
            return false;
        }
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
            const response = await fetchSyncPost("/api/block/moveBlock", payload);
            console.log(`[${PLUGIN_NAME}]`, `moveSubDocBlockToDoc(${source})`, payload, response);
            if (response.code === 0) {
                moved = true;
                previousID = blockId;
                this.rememberBlockSubDoc(blockId, subDocId);
            } else {
                showMessage(`${this.i18n.moveBlockFailed}: ${response.msg}`);
            }
        }
        return moved;
    }

    shouldSkipRecentDocMove(subDocId, targetParentDocId) {
        const key = `${subDocId}::${targetParentDocId}`;
        const now = Date.now();
        const last = this.recentDocMoveKeys.get(key);
        if (last && now - last < SYNC_DEDUPE_MS) {
            return true;
        }
        return false;
    }

    markRecentDocMove(subDocId, targetParentDocId) {
        const key = `${subDocId}::${targetParentDocId}`;
        this.recentDocMoveKeys.set(key, Date.now());
    }

    async handleDocMove(moveInfo, source) {
        let movedSubDocIds = [];
        if (moveInfo.byId && Array.isArray(moveInfo.fromIDs)) {
            movedSubDocIds = moveInfo.fromIDs;
        } else if (Array.isArray(moveInfo.fromPaths)) {
            movedSubDocIds = moveInfo.fromPaths
                .map((entry) => docIdFromFromPathEntry(entry))
                .filter(Boolean);
        }

        for (const subDocId of movedSubDocIds) {
            if (!subDocId || !(await isDocumentPresent(subDocId))) {
                continue;
            }

            if (isSelfDocTreeMove(subDocId, moveInfo)) {
                console.log(`[${PLUGIN_NAME}]`, `handleDocMove(${source}) skip self-move`, { subDocId, moveInfo });
                continue;
            }

            const targetParentDocId = await resolveMoveTargetParentDocId(moveInfo, subDocId, this);
            if (!targetParentDocId || targetParentDocId === subDocId) {
                if (await isSubDocAtNotebookRoot(subDocId)) {
                    if (this.shouldSkipRecentDocMove(subDocId, NOTEBOOK_ROOT_MOVE_KEY)) {
                        continue;
                    }
                    this.markRecentDocMove(subDocId, NOTEBOOK_ROOT_MOVE_KEY);
                    await this.removeSubDocBlocksOnRootMove(subDocId, source);
                    continue;
                }
                console.warn(`[${PLUGIN_NAME}]`, `handleDocMove(${source}) missing target`, { subDocId, moveInfo });
                continue;
            }

            const trashNotebook = await this.resolveTrashNotebook();
            if (trashNotebook && targetParentDocId === trashNotebook.id) {
                continue;
            }

            const currentParentDocId = await resolveParentDocIdFromSql(subDocId);
            if (currentParentDocId === targetParentDocId && await areDocBlocksInDoc(subDocId, targetParentDocId)) {
                console.log(`[${PLUGIN_NAME}]`, `handleDocMove(${source}) skip unchanged parent`, { subDocId, targetParentDocId });
                continue;
            }

            if (this.shouldSkipRecentDocMove(subDocId, targetParentDocId)) {
                continue;
            }

            const blockIds = await findSubDocBlockIds(subDocId);
            console.log(`[${PLUGIN_NAME}]`, `handleDocMove(${source})`, { subDocId, targetParentDocId, blockIds });

            if (blockIds.length === 0) {
                const title = await getDocTitle(subDocId);
                this.markRecentDocMove(subDocId, targetParentDocId);
                this.scheduleBindSubDocBlock(targetParentDocId, subDocId, `${source}-move-bind`, title);
                this.clearDocMovePending(subDocId);
                continue;
            }

            this.markRecentDocMove(subDocId, targetParentDocId);
            const moved = await this.moveSubDocBlockToDoc(subDocId, targetParentDocId, source);
            if (moved) {
                this.clearDocMovePending(subDocId);
            }
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
        if (this.slashInProgressForParent === parentDocId) {
            console.log(`[${PLUGIN_NAME}]`, "onSubDocCreated skip slash in-progress", { subDocId, source });
            return;
        }
        if (this.insertingSubDocBlocks.has(subDocId)) {
            console.log(`[${PLUGIN_NAME}]`, "onSubDocCreated skip in-flight", { subDocId, source });
            return;
        }
        console.log(`[${PLUGIN_NAME}]`, "onSubDocCreated", { subDocId, parentDocId, source });
        this.scheduleBindSubDocBlock(parentDocId, subDocId, source, titleHint);
    }

    scheduleBindSubDocBlock(parentDocId, subDocId, source, titleHint = null, triggerBlockId = null) {
        if (!subDocId || !parentDocId || this.insertingSubDocBlocks.has(subDocId)) {
            return;
        }
        this.insertingSubDocBlocks.add(subDocId);
        this.bindSubDocBlock(parentDocId, subDocId, source, titleHint, triggerBlockId)
            .catch((error) => {
                console.warn(`[${PLUGIN_NAME}]`, "bindSubDocBlock failed", error);
            })
            .finally(() => {
                this.insertingSubDocBlocks.delete(subDocId);
            });
    }

    async bindSubDocBlock(parentDocId, subDocId, source, titleHint = null, triggerBlockId = null) {
        console.log(`[${PLUGIN_NAME}]`, `bindSubDocBlock(${source})`, { parentDocId, subDocId, triggerBlockId });

        if (!subDocId || !parentDocId || parentDocId === subDocId) {
            return false;
        }

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
            return true;
        }

        let title = cleanTitle(titleHint);
        if (!title) {
            const docRow = await getDocumentRow(subDocId);
            title = cleanTitle(docRow?.content);
        }
        title = title || "未命名";

        if (triggerBlockId && triggerBlockId !== parentDocId) {
            if (!(await isBlockRowPresent(triggerBlockId))) {
                await ensureBlockReadyAfterSignal(triggerBlockId);
            }
            if (await isBlockRowPresent(triggerBlockId)) {
                const markdown = await buildSubDocBlockMarkdown(subDocId, title, getDocBlockHeadingLevel(this));
                const updateRes = await fetchSyncPost("/api/block/updateBlock", {
                    id: triggerBlockId,
                    dataType: "markdown",
                    data: markdown,
                });
                if (updateRes.code === 0) {
                    this.markRecentCreate(parentDocId, subDocId);
                    await setDocBlockAttrs(triggerBlockId, subDocId);
                    this.rememberBlockSubDoc(triggerBlockId, subDocId);
                    await setDocBlockIdOnDoc(subDocId, triggerBlockId);
                    decorateSubDocBlocks(document, this);
                    console.log(`[${PLUGIN_NAME}]`, `bindSubDocBlock(${source}) updated trigger block`, triggerBlockId);
                    return true;
                }
                console.warn(`[${PLUGIN_NAME}]`, `bindSubDocBlock(${source}) updateBlock failed`, updateRes);
                await this.cleanupSlashTriggerByBlockId(triggerBlockId);
            } else {
                console.warn(`[${PLUGIN_NAME}]`, `bindSubDocBlock(${source}) trigger block missing`, triggerBlockId);
            }
        }

        return this.appendSubDocBlockAtParentEnd(parentDocId, subDocId, source, title);
    }

    async appendSubDocBlockAtParentEnd(parentDocId, subDocId, source, title) {
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
            showMessage(`${this.i18n.createBlockFailed}: ${response.msg}`);
            return false;
        }

        const blockId = extractNewBlockId(response);
        if (!blockId || blockId === subDocId) {
            return false;
        }

        this.markRecentCreate(parentDocId, subDocId);
        this.rememberBlockSubDoc(blockId, subDocId);
        await setDocBlockAttrs(blockId, subDocId);
        await setDocBlockIdOnDoc(subDocId, blockId);
        decorateSubDocBlocks(document, this);
        console.log(`[${PLUGIN_NAME}]`, "appendSubDocBlockAtParentEnd ready", { blockId, subDocId, parentDocId });
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
        const { subDocId, parentDocId, title } = this.extractCreateIds(requestBody, responsePayload);
        console.log(`[${PLUGIN_NAME}]`, `handleCreateFromApi(${source})`, {
            subDocId,
            parentDocId,
            path: requestBody?.path,
        });
        this.onSubDocCreated(subDocId, parentDocId, source, title);
    }

    async removeLinkedSubDoc(subDocId, source) {
        this.scheduleDocMove(subDocId, "trash", { source });
    }

    async syncSubDocBlockTitle(subDocId, title, source) {
        if (!subDocId || !title || this.shouldSkipRecentSync(subDocId)) {
            return;
        }
        if (!(await isDocumentPresent(subDocId))) {
            return;
        }
        const blockIds = await this.resolveDocBlockIds(subDocId);
        if (blockIds.length === 0) {
            this.pendingTitleSync.set(subDocId, title);
            console.log(`[${PLUGIN_NAME}]`, `syncSubDocBlockTitle(${source}) defer: no blocks yet`, subDocId);
            return;
        }
        blockIds.forEach((blockId) => this.rememberBlockSubDoc(blockId, subDocId));
        const markdown = await buildSubDocBlockMarkdown(subDocId, title, getDocBlockHeadingLevel(this));
        console.log(`[${PLUGIN_NAME}]`, `syncSubDocBlockTitle(${source})`, { subDocId, title, blockIds });
        for (const blockId of blockIds) {
            if (this.pendingBlockCreates.has(blockId)) {
                continue;
            }
            if (!(await isBlockRowPresent(blockId))) {
                continue;
            }
            const response = await fetchSyncPost("/api/block/updateBlock", {
                id: blockId,
                dataType: "markdown",
                data: markdown,
            });
            console.log(`[${PLUGIN_NAME}]`, `updateBlock(${source})`, blockId, response);
            if (response.code === 0) {
                await this.reapplyDocBlockAttrs(blockId, subDocId);
            }
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
                } catch (error) {
                    console.warn(`[${PLUGIN_NAME}]`, "parse fetch body failed", error);
                }
            }

            const response = await plugin.originalFetch(input, init);

            if (ctx?.create) {
                response.clone().json().then((payload) => {
                    if (payload?.code !== 0) {
                        console.warn(`[${PLUGIN_NAME}]`, "create API failed", payload);
                        return;
                    }
                    plugin.handleCreateFromApi(ctx.create.body, payload, ctx.create.source);
                }).catch((error) => {
                    console.warn(`[${PLUGIN_NAME}]`, "read create response failed", error);
                });
            }

            if (shouldApplyApiContext(url, ctx)) {
                response.clone().json().then(async (payload) => {
                    if (payload?.code !== 0) {
                        return;
                    }
                    await applyApiContext(ctx, plugin, "fetch");
                }).catch(() => {});
            }

            return response;
        };

        console.log(`[${PLUGIN_NAME}]`, "window.fetch patched");
    }

    onunload() {
        for (const subDocId of [...this.docMovePending.keys()]) {
            this.clearDocMovePending(subDocId);
        }
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
        document.getElementById(STYLE_ID)?.remove();
        if (window.__subDocBlockFetchPatched && this.originalFetch) {
            window.fetch = this.originalFetch;
            window.__subDocBlockFetchPatched = false;
        }
        console.log(`${PLUGIN_NAME} 插件已卸载`);
    }
};
