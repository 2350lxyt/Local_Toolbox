import { renderMarkdown } from "./md-core.js";

let failed = 0;
function check(name, cond) {
  if (!cond) {
    failed += 1;
    console.log("FAIL:", name);
  }
}

// 1. 综合样例
const sample = [
  "# 标题",
  "",
  "**粗体** *斜体* ~~删除~~ `code`",
  "",
  "- a",
  "- [x] done",
  "  - nested",
  "",
  "1. one",
  "2. two",
  "",
  "> quote",
  "> > nested quote",
  "",
  "| h1 | h2 |",
  "| --- | :-: |",
  "| a | b |",
  "",
  "```js",
  "const x = 1; // c",
  "```",
  "",
  "![alt](https://x.com/a.png) [l](https://e.com) [bad](javascript:alert(1))",
].join("\n");
const t1 = renderMarkdown(sample);
console.log("t1 stats:", JSON.stringify(t1.stats), "warnings:", t1.warnings);
check("t1 blocks>5", t1.stats.blocks >= 7);
check("t1 no <img>", !t1.html.includes("<img"));
check("t1 javascript: 协议降级", !t1.html.includes('href="javascript:') && t1.html.includes("mv-deadlink"));
check("t1 https 链接保留", t1.html.includes('href="https://e.com"'));
check("t1 图片chip", t1.html.includes("mv-imgchip"));
check("t1 复制按钮", t1.html.includes('data-mv-code-copy="0"'));
check("t1 代码原始文本", t1.codeBlocks[0] === "const x = 1; // c");
check("t1 高亮keyword", t1.html.includes("mv-tok-keyword"));
check("t1 任务列表", t1.html.includes("mv-task") && t1.html.includes("checked"));
check("t1 嵌套列表", t1.html.includes("<ul><li><span>nested"));
check("t1 表格对齐", t1.html.includes('text-align:center'));

// 2. 空内容
const t2 = renderMarkdown("");
check("t2 empty", t2.html === "" && t2.stats.blocks === 0 && t2.stats.chars === 0);

// 3. 未闭合围栏
const t3 = renderMarkdown("```\nunclosed\nline2");
check("t3 warning", t3.warnings.length === 1);
check("t3 code captured", t3.codeBlocks[0] === "unclosed\nline2");

// 4. XSS
const t4 = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)> **b**', { allowRawHtml: true });
check("t4 script escaped", !t4.html.includes("<script>"));
check("t4 img escaped", !t4.html.includes("<img"));
check("t4 bold ok", t4.html.includes("<strong>"));

// 5. 白名单 HTML
const t5 = renderMarkdown('<strong class="x" onclick="y()">ok</strong> <em>fine</em>', { allowRawHtml: true });
check("t5 onclick stripped", !t5.html.includes("onclick"));
check("t5 em passthrough", t5.html.includes("<em>fine</em>"));

// 6. 深嵌套
let deep = "";
for (let i = 0; i < 30; i += 1) deep += "  ".repeat(i) + "- x\n";
const t6 = renderMarkdown(deep);
check("t6 deep flatten warned", t6.warnings.length >= 1);

// 7. 大文本性能与超长代码块降级
const bigCode = "```js\n" + "let a = 1;\n".repeat(4000) + "```";
const t7 = renderMarkdown(bigCode);
check("t7 超长代码块无高亮span", !t7.html.includes("mv-tok-keyword"));
const t0 = Date.now();
renderMarkdown("# t\n\n" + "some **para** text line\n\n".repeat(20000));
console.log("40k-line doc render ms:", Date.now() - t0);

// 8. CRLF 与转义
const t8 = renderMarkdown("# a\r\n\r\n\\*not em\\* and \\| pipe");
check("t8 CRLF ok", t8.stats.blocks === 2);
check("t8 转义星号", !t8.html.includes("<em>"));

// 9. 行内代码里的星号
const t9 = renderMarkdown("a `*b*` c");
check("t9 codespan 原样", t9.html.includes("<code") && !t9.html.slice(t9.html.indexOf("<code")).includes("<em>"));

// 10. 自动链接尾部标点
const t10 = renderMarkdown("see https://a.com/x.");
check("t10 尾标点不进URL", t10.html.includes('href="https://a.com/x"'));

// 11. 永不抛错 fuzz
const nasty = ["`", "``", "***", "[", "![", "](", "|", "| | |", ":-", "\\\\", "~~~~x~~~~", "<a href='x'>", "\u0000"];
nasty.forEach((s, i) => {
  try {
    renderMarkdown(s);
  } catch (e) {
    failed += 1;
    console.log("FAIL: threw on", JSON.stringify(s), e.message);
  }
});

console.log(failed === 0 ? "ALL PASS" : `${failed} FAILURES`);
