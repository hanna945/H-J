#!/usr/bin/env node
/**
 * 檢查「後台每日收益表解析邏輯」在三個地方是否還一致:
 *   1. H-J/index.html(前端,手動上傳 .xlsx 用)—— 擷取 LEDGER_PARSER_SYNC_CHECK:START ~ :END 之間的內容
 *   2. H-J/functions/_shared/ledgerParser.js(後端 Pages Function,/api/sheets/sync 用)
 *   3. brand-report-cron-sync/src/ledgerParser.js(排程 Worker,每天自動同步用)
 *
 * 這三份的原始碼不會完全逐字相同(前端是內嵌變數宣告,後端兩份是 export 出去的模組),
 * 所以比對前會先「正規化」掉這些預期中的差異(export 關鍵字、整行註解、空白行、行首行尾空白),
 * 正規化之後如果還有差異,才代表解析「邏輯」本身跑掉了,而不是單純的寫法差異。
 *
 * 用法:
 *   node check-ledger-parser-sync.js [H-J repo 路徑] [brand-report-cron-sync repo 路徑]
 *   兩個路徑都省略的話,預設抓「這支腳本所在資料夾」的上一層裡,跟 H-J 同一層的 brand-report-cron-sync。
 *   例如你平常把兩個 repo clone 在同一個資料夾下面:
 *     workspace/H-J/tools/check-ledger-parser-sync.js
 *     workspace/brand-report-cron-sync/
 *   直接 `node H-J/tools/check-ledger-parser-sync.js` 不用帶參數就抓得到。
 *
 * 結束碼:一致 → 0;不一致或讀不到檔案 → 1(方便之後如果要串進 CI/pre-commit hook 也能直接用)。
 */

const fs = require("fs");
const path = require("path");

const START_MARK = "// LEDGER_PARSER_SYNC_CHECK:START";
const END_MARK = "// LEDGER_PARSER_SYNC_CHECK:END";

const hjRepoArg = process.argv[2];
const cronRepoArg = process.argv[3];

// 這支腳本預期放在 H-J/tools/ 底下,所以「../..」就是 H-J repo 本身;
// 沒有透過參數指定的話,再往上一層找同名層級的 brand-report-cron-sync。
const scriptDir = __dirname;
const defaultHjRepo = path.resolve(scriptDir, "..");
const defaultCronRepo = path.resolve(scriptDir, "..", "..", "brand-report-cron-sync");

const hjRepo = hjRepoArg ? path.resolve(hjRepoArg) : defaultHjRepo;
const cronRepo = cronRepoArg ? path.resolve(cronRepoArg) : defaultCronRepo;

const frontendPath = path.join(hjRepo, "index.html");
const backendPath = path.join(hjRepo, "functions", "_shared", "ledgerParser.js");
const cronPath = path.join(cronRepo, "src", "ledgerParser.js");

function readFileOrExit(label, filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`✗ 找不到「${label}」:${filePath}`);
    console.error(`  請確認路徑正確,或用參數指定:node check-ledger-parser-sync.js <H-J路徑> <brand-report-cron-sync路徑>`);
    process.exit(1);
  }
  return fs.readFileSync(filePath, "utf8");
}

function extractBetweenMarkers(fullText, label) {
  const startIdx = fullText.indexOf(START_MARK);
  const endIdx = fullText.indexOf(END_MARK);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    console.error(`✗ 在「${label}」裡找不到 ${START_MARK} / ${END_MARK} 標記,可能被誤刪了。`);
    process.exit(1);
  }
  // 從 START 標記那一整行的「下一行」開始擷取(標記後面可能還有註解文字,不能只跳過標記文字本身),
  // 否則標記行剩下的文字會被誤當成內容的第一行,後續每一行都會跟著錯位。
  const afterStartLineBreak = fullText.indexOf("\n", startIdx);
  return fullText.slice(afterStartLineBreak + 1, endIdx);
}

// 正規化:拿掉 export 關鍵字、整行註解、行尾的行內註解、空白行,並把每一行前後空白去掉。
// 三份檔案的「註解文字」本來就沒必要逐字相同(那是給人看的說明,不影響執行結果),
// 這裡刻意把註解都拿掉,只比對「會被執行的程式碼」,才不會因為註解措辭不同就一直誤報不一致。
// 這個「從 // 開始到行尾都當註解拿掉」的做法,是針對這個檔案調校的簡化版,不是通用的 JS 註解剖析器——
// 這份解析邏輯裡目前沒有任何字串或正則表達式包含 // ,所以不會誤砍到程式碼本身;
// 如果之後解析邏輯改動到需要用到含有 // 的字串/正則,要留意這裡可能誤判,直接手動比對那一段就好。
function normalize(code) {
  return code
    .split("\n")
    .map((line) => line.replace(/^export\s+/, ""))
    .map((line) => {
      const idx = line.indexOf("//");
      return (idx === -1 ? line : line.slice(0, idx)).trim();
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

function diffLines(labelA, linesA, labelB, linesB) {
  const max = Math.max(linesA.length, linesB.length);
  const diffs = [];
  for (let i = 0; i < max; i++) {
    if (linesA[i] !== linesB[i]) {
      diffs.push({ line: i + 1, a: linesA[i] ?? "(不存在)", b: linesB[i] ?? "(不存在)" });
    }
  }
  return diffs;
}

const frontendRaw = extractBetweenMarkers(readFileOrExit("H-J/index.html", frontendPath), "H-J/index.html");
const backendRaw = readFileOrExit("H-J/functions/_shared/ledgerParser.js", backendPath);
const cronRaw = readFileOrExit("brand-report-cron-sync/src/ledgerParser.js", cronPath);

const pairs = [
  { labelA: "前端 index.html", codeA: frontendRaw, labelB: "後端 functions/_shared/ledgerParser.js", codeB: backendRaw },
  { labelA: "後端 functions/_shared/ledgerParser.js", codeA: backendRaw, labelB: "排程 Worker src/ledgerParser.js", codeB: cronRaw },
];

let allOk = true;
for (const { labelA, codeA, labelB, codeB } of pairs) {
  const linesA = normalize(codeA).split("\n");
  const linesB = normalize(codeB).split("\n");
  const diffs = diffLines(labelA, linesA, labelB, linesB);
  if (diffs.length === 0) {
    console.log(`✓ 一致:「${labelA}」 vs 「${labelB}」`);
  } else {
    allOk = false;
    console.log(`✗ 不一致:「${labelA}」 vs 「${labelB}」,共 ${diffs.length} 處差異(正規化後逐行比對,行號僅供定位參考,不是原始檔案行號):`);
    diffs.slice(0, 20).forEach((d) => {
      console.log(`  第 ${d.line} 行`);
      console.log(`    ${labelA}: ${d.a}`);
      console.log(`    ${labelB}: ${d.b}`);
    });
    if (diffs.length > 20) console.log(`  ...還有 ${diffs.length - 20} 處差異未列出`);
  }
}

console.log("");
if (allOk) {
  console.log("三份解析邏輯目前一致。");
  process.exit(0);
} else {
  console.log("三份解析邏輯已經跑掉了——如果是刻意調整,記得把另外兩份也手動同步改成一樣;如果不是,代表漏改了。");
  process.exit(1);
}
