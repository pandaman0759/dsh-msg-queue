/**
 * dsh-msg-queue —— 宿主半边（空逻辑）
 *
 * 所有功能都在客户端半边 `client.js`。宿主半边存在的唯一理由是让这个包成为
 * cordis 树上的一行：`dsh.client` 的浏览器产物是靠「Loader 条目里有这个包」
 * 被 dsh-client-modules 扫出来、编进页面启动表的；没有宿主条目，客户端产物
 * 永远不会被加载。
 *
 * 三条纪律：
 *   1. apply() 绝不抛错（同步抛错会让该条目失败，启动审计会报成插件加载失败）。
 *   2. 不声明任何 inject —— 本插件不使用宿主能力，声明一个从未被 provide 的服务
 *      会让 fiber 停在 PENDING，拖累整棵插件树。
 *   3. 不打日志噪音：这个插件装好就该安静地待在左边。
 */
export function apply() {}
