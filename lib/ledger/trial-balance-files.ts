import type { TrialBalance } from "@/lib/ledger/trial-balance";

/**
 * File renderings of a TrialBalance — CSV (flat, tool-importable) and XLSX
 * (the CPA-facing workbook: header block, frozen panes, money formats,
 * prior-years row seated at the end of equity, Net Income / Check Total
 * with rule borders). Kept out of the route file so they're unit-testable
 * (Next restricts route.ts exports to HTTP verbs).
 */

// ── Shared row assembly ───────────────────────────────────────────────────────

const toDollars = (cents: number) => cents / 100;

/** Column headers after "Account": activity columns (if >1) then Total/Balance. */
function columns(tb: TrialBalance): string[] {
  return tb.activities.length ? [...tb.activities, "Total"] : ["Balance"];
}

/** One row's numeric cells in column order; null renders as blank. */
function cells(
  tb: TrialBalance,
  byActivity: Record<string, number>,
  total: number
): (number | null)[] {
  if (!tb.activities.length) return [toDollars(total)];
  return [
    ...tb.activities.map((a) =>
      byActivity[a] !== undefined ? toDollars(byActivity[a]) : null
    ),
    toDollars(total),
  ];
}

// ── CSV ───────────────────────────────────────────────────────────────────────

export function toCsv(entityName: string, tb: TrialBalance): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const num = (v: number | null) => (v === null ? "" : v.toFixed(2));
  const lines: string[] = [];
  lines.push(`Trial Balance,${esc(entityName)},As of ${tb.asOf},debits positive / credits negative`);
  lines.push(["Account", "Type", "Classification", ...columns(tb)].map(esc).join(","));
  for (const r of tb.rows) {
    lines.push(
      [
        esc(r.name),
        esc(r.accountType),
        esc(r.classification),
        ...cells(tb, r.byActivity, r.totalCents).map(num),
      ].join(",")
    );
  }
  lines.push(
    ["Profit for all prior years", "", "equity", ...cells(tb, tb.priorYearsProfit, tb.priorYearsProfitTotal).map(num)].join(",")
  );
  lines.push(
    ["Net Income", "", "", ...cells(tb, tb.netIncome, tb.netIncomeTotal).map(num)].join(",")
  );
  lines.push(
    ["Check Total", "", "", ...cells(tb, tb.checkTotal, tb.checkTotalTotal).map(num)].join(",")
  );
  return lines.join("\n") + "\n";
}

// ── XLSX ──────────────────────────────────────────────────────────────────────

export async function toXlsx(entityName: string, tb: TrialBalance): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Trial Balance", {
    views: [{ state: "frozen", ySplit: 5 }],
  });
  const cols = columns(tb);
  const MONEY = "#,##0.00;-#,##0.00";

  ws.getCell("A1").value = "Trial Balance";
  ws.getCell("A1").font = { bold: true, size: 14 };
  ws.getCell("A2").value = entityName;
  ws.getCell("A2").font = { bold: true };
  ws.getCell("A3").value = `As of ${tb.asOf}`;
  ws.getCell("A4").value = "Per books (unadjusted) — debits positive, credits negative";
  ws.getCell("A4").font = { italic: true, size: 9 };

  const header = ws.getRow(5);
  header.getCell(1).value = "ACCOUNTS";
  cols.forEach((c, i) => (header.getCell(i + 2).value = c.toUpperCase()));
  header.font = { bold: true };
  header.eachCell((c) => (c.border = { bottom: { style: "thin" } }));

  let rowIdx = 6;
  let lastCls = "";
  let priorRowWritten = false;
  const writeMoneyRow = (
    label: string,
    byActivity: Record<string, number>,
    total: number
  ) => {
    const row = ws.getRow(rowIdx++);
    row.getCell(1).value = label;
    cells(tb, byActivity, total).forEach((v, i) => {
      const cell = row.getCell(i + 2);
      if (v !== null) cell.value = v;
      cell.numFmt = MONEY;
    });
  };
  const writePriorRow = () => {
    writeMoneyRow("Profit for all prior years", tb.priorYearsProfit, tb.priorYearsProfitTotal);
    priorRowWritten = true;
  };
  const PL_SECTIONS = new Set(["revenue", "expense"]);
  for (const r of tb.rows) {
    if (r.classification !== lastCls) {
      // "Profit for all prior years" sits at the end of equity — write it when
      // leaving equity, or before the first P&L section if equity had no rows.
      if (!priorRowWritten && (lastCls === "equity" || PL_SECTIONS.has(r.classification))) {
        writePriorRow();
      }
      if (lastCls !== "") rowIdx++; // blank spacer between sections
      lastCls = r.classification;
    }
    writeMoneyRow(r.name, r.byActivity, r.totalCents);
  }
  if (!priorRowWritten) writePriorRow(); // degenerate chart: no P&L rows at all

  rowIdx++;
  const ni = ws.getRow(rowIdx++);
  ni.getCell(1).value = "Net Income";
  ni.font = { bold: true };
  cells(tb, tb.netIncome, tb.netIncomeTotal).forEach((v, i) => {
    const cell = ni.getCell(i + 2);
    if (v !== null) cell.value = v;
    cell.numFmt = MONEY;
    cell.border = { top: { style: "thin" } };
  });
  const ck = ws.getRow(rowIdx++);
  ck.getCell(1).value = "Check Total";
  ck.font = { bold: true };
  cells(tb, tb.checkTotal, tb.checkTotalTotal).forEach((v, i) => {
    const cell = ck.getCell(i + 2);
    cell.value = v ?? 0;
    cell.numFmt = MONEY;
    cell.border = { top: { style: "double" } };
  });
  // ── Notes block — everything a preparer needs to read the workpaper cold ───
  const notes: string[] = [
    `Balance-sheet rows are cumulative through ${tb.asOf}; income and expense rows are ${tb.year} activity only.`,
    `"Profit for all prior years" is accumulated net income before Jan 1, ${tb.year} — these books do not close years, so it is presented as a computed equity row.`,
  ];
  if (tb.activities.length) {
    notes.push(
      "Columns segment the books by business activity; the per-activity Net Income row is the Schedule C/E split. Activity-column check totals show net inter-activity funding (one activity's cash paying another's items) — the Total column's zero proves the books balance."
    );
  }
  for (const f of tb.foreignColumns) {
    notes.push(
      `Column "${f}" holds entries recorded in these books that post to accounts now owned by the ${f} entity (history from an entity split). Consider a due-to/due-from reclass if material — the amounts also appear in ${f}'s own records only via its own entries, never double-counted.`
    );
  }
  rowIdx++;
  const nh = ws.getRow(rowIdx++);
  nh.getCell(1).value = "Notes";
  nh.font = { bold: true, size: 9 };
  for (const n of notes) {
    const row = ws.getRow(rowIdx++);
    row.getCell(1).value = n;
    row.getCell(1).font = { italic: true, size: 9 };
    row.getCell(1).alignment = { wrapText: true, vertical: "top" };
    ws.mergeCells(row.number, 1, row.number, cols.length + 1);
    // Rough wrap-height: the merged width fits ~110 chars per line at 9pt.
    row.height = Math.max(12, Math.ceil(n.length / 110) * 12);
  }

  ws.getColumn(1).width = 42;
  for (let i = 2; i <= cols.length + 1; i++) ws.getColumn(i).width = 16;

  return Buffer.from(await wb.xlsx.writeBuffer());
}
