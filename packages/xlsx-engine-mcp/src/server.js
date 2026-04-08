#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import ExcelJS from "exceljs";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// ── Column format presets ────────────────────────────────────────────────────

const FORMAT_MAP = {
  accounting: '#,##0.00;[Red]-#,##0.00',
  date: 'DD MMMM YYYY',
  percentage: '0.00%',
  number: '#,##0',
  text: '@',
  integer: '#,##0'
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function colLetterToNumber(letters) {
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return col;
}

function parseA1Range(range) {
  const match = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!match) return null;
  return {
    startCol: colLetterToNumber(match[1]),
    startRow: parseInt(match[2], 10),
    endCol: colLetterToNumber(match[3]),
    endRow: parseInt(match[4], 10)
  };
}

function setCellValue(cell, value, numFmt) {
  if (typeof value === "string" && value.startsWith("=")) {
    cell.value = { formula: value.slice(1) };
  } else {
    cell.value = value;
  }
  if (numFmt) {
    cell.numFmt = numFmt;
  }
}

// ── Zod schemas ──────────────────────────────────────────────────────────────

const ColumnSchema = z.object({
  header: z.string(),
  width: z.number().optional().default(15),
  format: z.enum(["accounting", "date", "percentage", "number", "text", "integer"]).optional()
});

const ConditionalFormattingRuleSchema = z.object({
  type: z.string(),
  priority: z.number().int(),
  operator: z.string().optional(),
  formulae: z.array(z.string()).optional(),
  style: z.record(z.unknown()).optional()
});

const ConditionalFormattingSchema = z.object({
  ref: z.string(),
  rules: z.array(ConditionalFormattingRuleSchema)
});

const DataValidationSchema = z.object({
  range: z.string(),
  type: z.string(),
  operator: z.string().optional(),
  formulae: z.array(z.string()).optional(),
  allowBlank: z.boolean().optional(),
  showErrorMessage: z.boolean().optional(),
  errorTitle: z.string().optional(),
  error: z.string().optional()
});

const NamedRangeSchema = z.object({
  name: z.string(),
  refFormula: z.string()
});

const FreezePanesSchema = z.object({
  xSplit: z.number().int().default(0),
  ySplit: z.number().int().default(0)
});

const PrintConfigSchema = z.object({
  orientation: z.enum(["portrait", "landscape"]).optional(),
  fitToPage: z.boolean().optional(),
  fitToWidth: z.number().int().optional(),
  fitToHeight: z.number().int().optional(),
  margins: z.object({
    top: z.number().optional(),
    bottom: z.number().optional(),
    left: z.number().optional(),
    right: z.number().optional(),
    header: z.number().optional(),
    footer: z.number().optional()
  }).optional(),
  repeatRows: z.string().optional().describe("Row range to repeat, e.g. '1:1'"),
  headerFooter: z.object({
    oddHeader: z.string().optional(),
    oddFooter: z.string().optional(),
    evenHeader: z.string().optional(),
    evenFooter: z.string().optional(),
    firstHeader: z.string().optional(),
    firstFooter: z.string().optional()
  }).optional()
});

const AutoFilterSchema = z.object({
  from: z.string().describe("Top-left cell, e.g. 'A1'"),
  to: z.string().describe("Bottom-right cell, e.g. 'F50'")
});

const SheetSchema = z.object({
  name: z.string(),
  columns: z.array(ColumnSchema),
  rows: z.array(z.array(z.unknown())).describe("2D array of cell values. Strings starting with = are treated as formulae."),
  namedRanges: z.array(NamedRangeSchema).optional(),
  conditionalFormatting: z.array(ConditionalFormattingSchema).optional(),
  dataValidation: z.array(DataValidationSchema).optional(),
  freezePanes: FreezePanesSchema.optional(),
  autoFilter: AutoFilterSchema.optional(),
  printConfig: PrintConfigSchema.optional(),
  tabColor: z.string().optional().describe("Tab color as hex, e.g. 'FF0000'")
});

const OperationSchema = z.object({
  type: z.enum([
    "addSheet", "deleteSheet", "insertRows", "updateCells", "deleteRows",
    "addNamedRange", "addConditionalFormatting", "addFormula", "setColumnWidth",
    "mergeCells", "addDataValidation", "updatePrintConfig"
  ]),
  sheet: z.string().optional().describe("Target sheet name (not required for addSheet/deleteSheet)"),
  // addSheet
  sheetName: z.string().optional(),
  columns: z.array(ColumnSchema).optional(),
  // insertRows / deleteRows
  startRow: z.number().int().optional(),
  rows: z.array(z.array(z.unknown())).optional(),
  count: z.number().int().optional(),
  // updateCells
  cells: z.array(z.object({
    ref: z.string().describe("Cell reference, e.g. 'B5'"),
    value: z.unknown()
  })).optional(),
  // addNamedRange
  name: z.string().optional(),
  refFormula: z.string().optional(),
  // addConditionalFormatting
  ref: z.string().optional(),
  rules: z.array(ConditionalFormattingRuleSchema).optional(),
  // addFormula
  cell: z.string().optional(),
  formula: z.string().optional(),
  // setColumnWidth
  column: z.number().int().optional(),
  width: z.number().optional(),
  // mergeCells
  range: z.string().optional(),
  // addDataValidation
  validation: DataValidationSchema.optional(),
  // updatePrintConfig
  printConfig: PrintConfigSchema.optional()
});

const AnalysisTypeSchema = z.enum([
  "variance", "sumValidation", "formulaAudit", "inconsistencyCheck", "statistical"
]);

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "wcjr-xlsx-engine",
  version: "0.1.0"
});

// ── Tool 1: create_workbook ──────────────────────────────────────────────────

server.registerTool(
  "create_workbook",
  {
    description: "Create a new Excel workbook from a flexible schema. Supports formulae, named ranges, conditional formatting, data validation, freeze panes, auto filters, print configuration, and tab colours.",
    inputSchema: {
      outputPath: z.string().describe("Absolute path for the output .xlsx file."),
      sheets: z.array(SheetSchema).min(1).describe("Array of sheet definitions."),
      creator: z.string().optional().default("WCJR MCP").describe("Workbook creator metadata.")
    }
  },
  async ({ outputPath, sheets, creator }) => {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = creator;
    workbook.created = new Date();

    const sheetSummaries = [];

    for (const sheetDef of sheets) {
      const ws = workbook.addWorksheet(sheetDef.name);

      if (sheetDef.tabColor) {
        ws.properties.tabColor = { argb: sheetDef.tabColor };
      }

      // Columns
      ws.columns = sheetDef.columns.map((col) => ({
        header: col.header,
        width: col.width ?? 15
      }));

      // Apply header row number formats to columns
      const colFormats = sheetDef.columns.map((col) =>
        col.format ? FORMAT_MAP[col.format] : undefined
      );

      // Rows
      for (const rowData of sheetDef.rows) {
        const row = ws.addRow([]);
        for (let i = 0; i < rowData.length; i++) {
          const cell = row.getCell(i + 1);
          setCellValue(cell, rowData[i], colFormats[i]);
        }
      }

      // Named ranges
      if (sheetDef.namedRanges) {
        for (const nr of sheetDef.namedRanges) {
          workbook.definedNames.addDefinedName({
            name: nr.name,
            refFormula: nr.refFormula
          });
        }
      }

      // Conditional formatting
      if (sheetDef.conditionalFormatting) {
        for (const cf of sheetDef.conditionalFormatting) {
          ws.addConditionalFormatting({
            ref: cf.ref,
            rules: cf.rules
          });
        }
      }

      // Data validation
      if (sheetDef.dataValidation) {
        for (const dv of sheetDef.dataValidation) {
          ws.dataValidations.add(dv.range, {
            type: dv.type,
            operator: dv.operator,
            formulae: dv.formulae,
            allowBlank: dv.allowBlank,
            showErrorMessage: dv.showErrorMessage,
            errorTitle: dv.errorTitle,
            error: dv.error
          });
        }
      }

      // Freeze panes
      if (sheetDef.freezePanes) {
        ws.views = [{
          state: "frozen",
          xSplit: sheetDef.freezePanes.xSplit,
          ySplit: sheetDef.freezePanes.ySplit
        }];
      }

      // Auto filter
      if (sheetDef.autoFilter) {
        ws.autoFilter = {
          from: sheetDef.autoFilter.from,
          to: sheetDef.autoFilter.to
        };
      }

      // Print config
      if (sheetDef.printConfig) {
        const pc = sheetDef.printConfig;
        if (pc.orientation) ws.pageSetup.orientation = pc.orientation;
        if (pc.fitToPage) {
          ws.pageSetup.fitToPage = true;
          if (pc.fitToWidth != null) ws.pageSetup.fitToWidth = pc.fitToWidth;
          if (pc.fitToHeight != null) ws.pageSetup.fitToHeight = pc.fitToHeight;
        }
        if (pc.margins) {
          ws.pageSetup.margins = pc.margins;
        }
        if (pc.repeatRows) {
          ws.pageSetup.printTitlesRow = pc.repeatRows;
        }
        if (pc.headerFooter) {
          ws.headerFooter = pc.headerFooter;
        }
      }

      sheetSummaries.push({
        name: sheetDef.name,
        rows: sheetDef.rows.length,
        columns: sheetDef.columns.length,
        namedRanges: sheetDef.namedRanges?.length ?? 0
      });
    }

    await workbook.xlsx.writeFile(outputPath);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ outputPath, sheets: sheetSummaries }, null, 2)
      }]
    };
  }
);

// ── Tool 2: read_workbook ────────────────────────────────────────────────────

server.registerTool(
  "read_workbook",
  {
    description: "Read an existing .xlsx workbook with full structural introspection. Returns sheet names, column headers with widths and number formats, row data with values and/or formulae, named ranges, and merged cells.",
    inputSchema: {
      filePath: z.string().describe("Absolute path to the .xlsx file."),
      sheets: z.array(z.string()).optional().describe("Filter to specific sheet names. Omit to read all."),
      includeFormulae: z.boolean().optional().default(true).describe("Include formula expressions in output."),
      range: z.string().optional().describe("A1 notation range to limit reading, e.g. 'A1:F50'.")
    }
  },
  async ({ filePath, sheets: sheetFilter, includeFormulae, range }) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const parsedRange = range ? parseA1Range(range) : null;
    const result = {
      filePath,
      sheetCount: workbook.worksheets.length,
      namedRanges: [],
      sheets: []
    };

    // Named ranges
    const definedNames = workbook.definedNames;
    if (definedNames && typeof definedNames.getDefinedNames === "function") {
      for (const dn of definedNames.getDefinedNames()) {
        result.namedRanges.push(dn);
      }
    }

    for (const ws of workbook.worksheets) {
      if (sheetFilter && !sheetFilter.includes(ws.name)) continue;

      const sheetData = {
        name: ws.name,
        rowCount: ws.rowCount,
        columnCount: ws.columnCount,
        columns: [],
        rows: [],
        mergedCells: []
      };

      // Column metadata
      for (let c = 1; c <= ws.columnCount; c++) {
        const col = ws.getColumn(c);
        const headerCell = ws.getRow(1).getCell(c);
        sheetData.columns.push({
          index: c,
          header: headerCell.value != null ? String(headerCell.value) : null,
          width: col.width ?? null,
          numFmt: col.numFmt ?? null
        });
      }

      // Row data
      ws.eachRow((row, rowNumber) => {
        if (parsedRange) {
          if (rowNumber < parsedRange.startRow || rowNumber > parsedRange.endRow) return;
        }
        const rowData = { row: rowNumber, cells: [] };
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          if (parsedRange) {
            if (colNumber < parsedRange.startCol || colNumber > parsedRange.endCol) return;
          }
          const cellData = {
            ref: cell.address,
            value: cell.value
          };
          if (includeFormulae && cell.value && typeof cell.value === "object" && cell.value.formula) {
            cellData.formula = cell.value.formula;
            cellData.value = cell.value.result ?? null;
          }
          rowData.cells.push(cellData);
        });
        sheetData.rows.push(rowData);
      });

      // Merged cells
      if (ws.model && ws.model.merges) {
        sheetData.mergedCells = ws.model.merges;
      }

      result.sheets.push(sheetData);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2)
      }]
    };
  }
);

// ── Tool 3: update_workbook ──────────────────────────────────────────────────

server.registerTool(
  "update_workbook",
  {
    description: "Modify an existing Excel workbook in place. Supports adding/deleting sheets, inserting/deleting rows, updating cells, adding named ranges, conditional formatting, formulae, column widths, merged cells, data validation, and print configuration.",
    inputSchema: {
      filePath: z.string().describe("Absolute path to the .xlsx file to modify."),
      operations: z.array(OperationSchema).min(1).describe("Array of operations to apply in order.")
    }
  },
  async ({ filePath, operations }) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const applied = [];

    for (const op of operations) {
      const ws = op.sheet ? workbook.getWorksheet(op.sheet) : null;

      switch (op.type) {
        case "addSheet": {
          const newWs = workbook.addWorksheet(op.sheetName ?? op.sheet);
          if (op.columns) {
            newWs.columns = op.columns.map((col) => ({
              header: col.header,
              width: col.width ?? 15
            }));
          }
          applied.push({ type: "addSheet", sheet: op.sheetName ?? op.sheet });
          break;
        }

        case "deleteSheet": {
          const target = op.sheet ?? op.sheetName;
          const toDelete = workbook.getWorksheet(target);
          if (toDelete) {
            workbook.removeWorksheet(toDelete.id);
            applied.push({ type: "deleteSheet", sheet: target });
          }
          break;
        }

        case "insertRows": {
          if (!ws) throw new Error(`Sheet "${op.sheet}" not found for insertRows.`);
          const startRow = op.startRow ?? (ws.rowCount + 1);
          if (op.rows) {
            for (let i = 0; i < op.rows.length; i++) {
              const row = ws.getRow(startRow + i);
              for (let j = 0; j < op.rows[i].length; j++) {
                setCellValue(row.getCell(j + 1), op.rows[i][j]);
              }
              row.commit();
            }
          }
          applied.push({ type: "insertRows", sheet: op.sheet, startRow, count: op.rows?.length ?? 0 });
          break;
        }

        case "updateCells": {
          if (!ws) throw new Error(`Sheet "${op.sheet}" not found for updateCells.`);
          if (op.cells) {
            for (const c of op.cells) {
              const cell = ws.getCell(c.ref);
              setCellValue(cell, c.value);
            }
          }
          applied.push({ type: "updateCells", sheet: op.sheet, count: op.cells?.length ?? 0 });
          break;
        }

        case "deleteRows": {
          if (!ws) throw new Error(`Sheet "${op.sheet}" not found for deleteRows.`);
          if (op.startRow && op.count) {
            ws.spliceRows(op.startRow, op.count);
          }
          applied.push({ type: "deleteRows", sheet: op.sheet, startRow: op.startRow, count: op.count });
          break;
        }

        case "addNamedRange": {
          if (op.name && op.refFormula) {
            workbook.definedNames.addDefinedName({
              name: op.name,
              refFormula: op.refFormula
            });
          }
          applied.push({ type: "addNamedRange", name: op.name });
          break;
        }

        case "addConditionalFormatting": {
          if (!ws) throw new Error(`Sheet "${op.sheet}" not found for addConditionalFormatting.`);
          if (op.ref && op.rules) {
            ws.addConditionalFormatting({ ref: op.ref, rules: op.rules });
          }
          applied.push({ type: "addConditionalFormatting", sheet: op.sheet, ref: op.ref });
          break;
        }

        case "addFormula": {
          if (!ws) throw new Error(`Sheet "${op.sheet}" not found for addFormula.`);
          if (op.cell && op.formula) {
            ws.getCell(op.cell).value = { formula: op.formula };
          }
          applied.push({ type: "addFormula", sheet: op.sheet, cell: op.cell });
          break;
        }

        case "setColumnWidth": {
          if (!ws) throw new Error(`Sheet "${op.sheet}" not found for setColumnWidth.`);
          if (op.column && op.width) {
            ws.getColumn(op.column).width = op.width;
          }
          applied.push({ type: "setColumnWidth", sheet: op.sheet, column: op.column });
          break;
        }

        case "mergeCells": {
          if (!ws) throw new Error(`Sheet "${op.sheet}" not found for mergeCells.`);
          if (op.range) {
            ws.mergeCells(op.range);
          }
          applied.push({ type: "mergeCells", sheet: op.sheet, range: op.range });
          break;
        }

        case "addDataValidation": {
          if (!ws) throw new Error(`Sheet "${op.sheet}" not found for addDataValidation.`);
          if (op.validation) {
            ws.dataValidations.add(op.validation.range, {
              type: op.validation.type,
              operator: op.validation.operator,
              formulae: op.validation.formulae,
              allowBlank: op.validation.allowBlank,
              showErrorMessage: op.validation.showErrorMessage,
              errorTitle: op.validation.errorTitle,
              error: op.validation.error
            });
          }
          applied.push({ type: "addDataValidation", sheet: op.sheet });
          break;
        }

        case "updatePrintConfig": {
          if (!ws) throw new Error(`Sheet "${op.sheet}" not found for updatePrintConfig.`);
          if (op.printConfig) {
            const pc = op.printConfig;
            if (pc.orientation) ws.pageSetup.orientation = pc.orientation;
            if (pc.fitToPage) {
              ws.pageSetup.fitToPage = true;
              if (pc.fitToWidth != null) ws.pageSetup.fitToWidth = pc.fitToWidth;
              if (pc.fitToHeight != null) ws.pageSetup.fitToHeight = pc.fitToHeight;
            }
            if (pc.margins) ws.pageSetup.margins = pc.margins;
            if (pc.repeatRows) ws.pageSetup.printTitlesRow = pc.repeatRows;
            if (pc.headerFooter) ws.headerFooter = pc.headerFooter;
          }
          applied.push({ type: "updatePrintConfig", sheet: op.sheet });
          break;
        }

        default:
          applied.push({ type: op.type, status: "unknown operation type" });
      }
    }

    await workbook.xlsx.writeFile(filePath);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ filePath, operationsApplied: applied }, null, 2)
      }]
    };
  }
);

// ── Tool 4: analyse_workbook ─────────────────────────────────────────────────

server.registerTool(
  "analyse_workbook",
  {
    description: "Perform computational analysis on an existing Excel workbook. Supports variance analysis, sum validation, formula audit, inconsistency checking, and statistical summaries.",
    inputSchema: {
      filePath: z.string().describe("Absolute path to the .xlsx file."),
      sheet: z.string().describe("Name of the sheet to analyse."),
      analyses: z.array(AnalysisTypeSchema).min(1).describe("Array of analysis types to perform."),
      varianceColumns: z.array(z.number().int()).optional().describe("Two column indices (1-based) for variance analysis, e.g. [2, 3]."),
      sumColumn: z.number().int().optional().describe("Column index (1-based) for sum validation."),
      totalRow: z.number().int().optional().describe("Row number containing the total for sum validation.")
    }
  },
  async ({ filePath, sheet, analyses, varianceColumns, sumColumn, totalRow }) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const ws = workbook.getWorksheet(sheet);
    if (!ws) throw new Error(`Sheet "${sheet}" not found.`);

    const results = {};

    for (const analysis of analyses) {
      switch (analysis) {
        case "variance": {
          if (!varianceColumns || varianceColumns.length < 2) {
            results.variance = { error: "varianceColumns must specify two column indices." };
            break;
          }
          const [colA, colB] = varianceColumns;
          const variances = [];
          ws.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return; // skip header
            const a = Number(row.getCell(colA).value);
            const b = Number(row.getCell(colB).value);
            if (!isNaN(a) && !isNaN(b)) {
              const diff = b - a;
              const pct = a !== 0 ? ((diff / Math.abs(a)) * 100) : null;
              variances.push({
                row: rowNumber,
                colA: a,
                colB: b,
                difference: diff,
                percentChange: pct != null ? Math.round(pct * 100) / 100 : null
              });
            }
          });
          results.variance = { columnA: colA, columnB: colB, rows: variances };
          break;
        }

        case "sumValidation": {
          if (!sumColumn || !totalRow) {
            results.sumValidation = { error: "sumColumn and totalRow are required." };
            break;
          }
          let computedSum = 0;
          let detailRows = 0;
          ws.eachRow((row, rowNumber) => {
            if (rowNumber === 1 || rowNumber === totalRow) return;
            const val = Number(row.getCell(sumColumn).value);
            if (!isNaN(val)) {
              computedSum += val;
              detailRows++;
            }
          });
          const totalValue = Number(ws.getRow(totalRow).getCell(sumColumn).value);
          results.sumValidation = {
            column: sumColumn,
            totalRow,
            computedSum: Math.round(computedSum * 100) / 100,
            statedTotal: isNaN(totalValue) ? null : totalValue,
            difference: isNaN(totalValue) ? null : Math.round((totalValue - computedSum) * 100) / 100,
            valid: !isNaN(totalValue) && Math.abs(totalValue - computedSum) < 0.01,
            detailRows
          };
          break;
        }

        case "formulaAudit": {
          const formulae = [];
          ws.eachRow((row, rowNumber) => {
            row.eachCell((cell) => {
              if (cell.value && typeof cell.value === "object" && cell.value.formula) {
                formulae.push({
                  ref: cell.address,
                  formula: cell.value.formula,
                  result: cell.value.result ?? null
                });
              }
            });
          });
          results.formulaAudit = { count: formulae.length, formulae };
          break;
        }

        case "inconsistencyCheck": {
          const columnTypes = {};
          ws.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;
            row.eachCell((cell, colNumber) => {
              if (!columnTypes[colNumber]) columnTypes[colNumber] = new Set();
              const val = cell.value;
              if (val == null) {
                columnTypes[colNumber].add("null");
              } else if (typeof val === "object" && val.formula) {
                columnTypes[colNumber].add("formula");
              } else {
                columnTypes[colNumber].add(typeof val);
              }
            });
          });
          const inconsistencies = [];
          for (const [col, types] of Object.entries(columnTypes)) {
            const typesArr = Array.from(types);
            if (typesArr.length > 1) {
              inconsistencies.push({
                column: parseInt(col, 10),
                types: typesArr,
                header: ws.getRow(1).getCell(parseInt(col, 10)).value
              });
            }
          }
          results.inconsistencyCheck = { columnsChecked: Object.keys(columnTypes).length, inconsistencies };
          break;
        }

        case "statistical": {
          const colStats = {};
          ws.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;
            row.eachCell((cell, colNumber) => {
              let val = cell.value;
              if (val && typeof val === "object" && val.result != null) val = val.result;
              if (typeof val !== "number") return;
              if (!colStats[colNumber]) colStats[colNumber] = { values: [], header: null };
              colStats[colNumber].values.push(val);
            });
          });

          const statsResult = {};
          for (const [col, data] of Object.entries(colStats)) {
            const colNum = parseInt(col, 10);
            const header = ws.getRow(1).getCell(colNum).value;
            const vals = data.values.sort((a, b) => a - b);
            const n = vals.length;
            if (n === 0) continue;
            const sum = vals.reduce((a, b) => a + b, 0);
            const mean = sum / n;
            const mid = Math.floor(n / 2);
            const median = n % 2 !== 0 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
            statsResult[colNum] = {
              header: header != null ? String(header) : null,
              count: n,
              min: vals[0],
              max: vals[n - 1],
              sum: Math.round(sum * 100) / 100,
              mean: Math.round(mean * 100) / 100,
              median: Math.round(median * 100) / 100
            };
          }
          results.statistical = statsResult;
          break;
        }
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ filePath, sheet, results }, null, 2)
      }]
    };
  }
);

// ── Tool 5: export_workbook ──────────────────────────────────────────────────

server.registerTool(
  "export_workbook",
  {
    description: "Export an Excel workbook to PDF via LibreOffice CLI (soffice --headless). Optionally export only specific sheets by creating a temporary workbook.",
    inputSchema: {
      filePath: z.string().describe("Absolute path to the .xlsx file."),
      outputPath: z.string().describe("Desired absolute path for the output PDF."),
      sheets: z.array(z.string()).optional().describe("Filter to specific sheet names. Omit to export all.")
    }
  },
  async ({ filePath, outputPath, sheets: sheetFilter }) => {
    const outDir = path.dirname(outputPath);
    await fs.mkdir(outDir, { recursive: true });

    let sourceFile = filePath;
    let tempFile = null;

    // If sheets are filtered, create a temp workbook with only those sheets
    if (sheetFilter && sheetFilter.length > 0) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);

      const tempWorkbook = new ExcelJS.Workbook();
      for (const ws of workbook.worksheets) {
        if (!sheetFilter.includes(ws.name)) continue;
        const newWs = tempWorkbook.addWorksheet(ws.name);
        // Copy rows
        ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
          const newRow = newWs.getRow(rowNumber);
          row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            const newCell = newRow.getCell(colNumber);
            newCell.value = cell.value;
            newCell.numFmt = cell.numFmt;
            newCell.style = cell.style;
          });
          newRow.commit();
        });
        // Copy column widths
        for (let c = 1; c <= ws.columnCount; c++) {
          const srcCol = ws.getColumn(c);
          const dstCol = newWs.getColumn(c);
          if (srcCol.width) dstCol.width = srcCol.width;
        }
      }

      tempFile = path.join(outDir, `_xlsx_engine_temp_${Date.now()}.xlsx`);
      await tempWorkbook.xlsx.writeFile(tempFile);
      sourceFile = tempFile;
    }

    try {
      await execFileAsync("soffice", [
        "--headless",
        "--convert-to", "pdf",
        "--outdir", outDir,
        sourceFile
      ], { timeout: 60000 });

      // LibreOffice names the output based on the input filename
      const libreOutputName = path.basename(sourceFile, path.extname(sourceFile)) + ".pdf";
      const libreOutputPath = path.join(outDir, libreOutputName);

      // Rename if the output path differs
      if (libreOutputPath !== outputPath) {
        try {
          await fs.rename(libreOutputPath, outputPath);
        } catch {
          // If rename fails (e.g. cross-device), try copy+delete
          await fs.copyFile(libreOutputPath, outputPath);
          await fs.unlink(libreOutputPath);
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            outputPath,
            sourceFile: filePath,
            sheetsExported: sheetFilter ?? "all"
          }, null, 2)
        }]
      };
    } finally {
      if (tempFile) {
        try { await fs.unlink(tempFile); } catch { /* ignore */ }
      }
    }
  }
);

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
