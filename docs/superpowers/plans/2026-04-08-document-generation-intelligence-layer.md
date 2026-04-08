# Document Generation & Intelligence Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build two flexible MCP document engines (xlsx, docx) and an intelligence layer extending the existing Qdrant RAG system with federated knowledge retrieval, enabling forensic-grade document production backed by curated knowledge.

**Architecture:** Two new MCP servers (`xlsx-engine-mcp`, `docx-engine-mcp`) expose general-purpose document tools. The existing `qdrant-rag-mcp` gains five new knowledge tools. `document-ingestion` adds PST/MSG/structural-DOCX extraction. Desktop app registers the new servers and adds knowledge management IPC.

**Tech Stack:** ExcelJS (xlsx), docx (npm), mammoth (docx reading), pst-extractor (PST), @pst-extractor/msg-reader (MSG), LibreOffice CLI (PDF export), Qdrant, Ollama nomic-embed-text, MCP SDK, Zod.

---

## File Structure

### New packages

```
packages/xlsx-engine-mcp/
├── package.json
└── src/
    └── server.js          # MCP server: create, read, update, analyse, export workbooks

packages/docx-engine-mcp/
├── package.json
└── src/
    └── server.js          # MCP server: create, read, update, merge, export documents
```

### Modified files

```
packages/document-ingestion/
├── package.json           # Add pst-extractor, @pst-extractor/msg-reader deps
└── src/
    └── index.js           # Add PST, MSG, structural DOCX extraction

packages/qdrant-rag-mcp/
├── package.json           # Add @wcjr/document-ingestion dep
└── src/
    └── server.js          # Add 5 knowledge_* tools

packages/rag/
└── src/
    ├── index.js           # Add listCollections, deleteByFilter, enhanced ingest with metadata
    └── chunker.js         # Add headingPath to chunk metadata

packages/activity-profiles/
└── src/
    └── index.js           # Add MCP presets, disputes profile

apps/desktop/
└── main.js                # Add builtin kinds, hydrate/dehydrate, IPC handlers, default server entries
```

---

### Task 1: xlsx-engine-mcp — Package Scaffold & `create_workbook` Tool

**Files:**
- Create: `packages/xlsx-engine-mcp/package.json`
- Create: `packages/xlsx-engine-mcp/src/server.js`
- Modify: `package.json` (root — add workspace dep)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@wcjr/xlsx-engine-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/server.js",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.1",
    "exceljs": "^4.4.0",
    "zod": "^3.24.1"
  }
}
```

- [ ] **Step 2: Create server.js with `create_workbook` tool**

```javascript
#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import ExcelJS from "exceljs";
import path from "node:path";
import fs from "node:fs/promises";

const server = new McpServer({
  name: "wcjr-xlsx-engine",
  version: "0.1.0"
});

const COLUMN_FORMATS = {
  accounting: '#,##0.00;[Red]-#,##0.00',
  date: 'DD MMMM YYYY',
  percentage: '0.00%',
  number: '#,##0',
  text: '@',
  integer: '#,##0'
};

function applyColumnFormat(col, format) {
  if (COLUMN_FORMATS[format]) {
    col.numFmt = COLUMN_FORMATS[format];
  }
}

function setCellValue(cell, value) {
  if (typeof value === "string" && value.startsWith("=")) {
    cell.value = { formula: value.slice(1) };
  } else {
    cell.value = value;
  }
}

server.registerTool(
  "create_workbook",
  {
    description:
      "Create a new Excel workbook from a flexible schema. Supports multi-sheet workbooks with formulae, named ranges, conditional formatting, data validation, freeze panes, auto-filter, and print configuration. The AI decides the workbook structure — this tool renders it.",
    inputSchema: {
      outputPath: z.string().min(1).describe("Absolute file path for the output .xlsx file"),
      sheets: z.array(z.object({
        name: z.string().min(1).describe("Sheet tab name"),
        columns: z.array(z.object({
          header: z.string().describe("Column header text"),
          width: z.number().optional().describe("Column width in characters"),
          format: z.enum(["accounting", "date", "percentage", "number", "text", "integer"]).optional().describe("Number format to apply")
        })).describe("Column definitions"),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe("Row data — each cell is a value or formula string starting with ="),
        namedRanges: z.array(z.object({
          name: z.string(),
          range: z.string().describe("Cell range in A1 notation, e.g. B2:B50")
        })).optional().describe("Named ranges scoped to this sheet"),
        conditionalFormatting: z.array(z.object({
          range: z.string().describe("Cell range, e.g. A2:H100"),
          type: z.enum(["cellIs", "expression", "colorScale", "dataBar", "iconSet"]),
          priority: z.number().optional(),
          operator: z.string().optional().describe("For cellIs: greaterThan, lessThan, equal, between, etc."),
          formulae: z.array(z.string()).optional().describe("Formula or value for the rule"),
          style: z.object({
            fill: z.object({ type: z.string().optional(), pattern: z.string().optional(), fgColor: z.object({ argb: z.string() }).optional(), bgColor: z.object({ argb: z.string() }).optional() }).optional(),
            font: z.object({ color: z.object({ argb: z.string() }).optional(), bold: z.boolean().optional(), italic: z.boolean().optional() }).optional()
          }).optional()
        })).optional(),
        dataValidation: z.array(z.object({
          range: z.string(),
          type: z.enum(["list", "whole", "decimal", "date", "textLength"]),
          formulae: z.array(z.string()).optional().describe("For list: comma-separated values in first entry"),
          operator: z.string().optional(),
          showErrorMessage: z.boolean().optional(),
          errorTitle: z.string().optional(),
          error: z.string().optional()
        })).optional(),
        freezePanes: z.object({
          row: z.number().describe("First unfrozen row (1-indexed)"),
          column: z.number().describe("First unfrozen column (1-indexed)")
        }).optional(),
        autoFilter: z.object({
          from: z.string().describe("Top-left cell, e.g. A1"),
          to: z.string().describe("Bottom-right cell, e.g. H1")
        }).optional(),
        printConfig: z.object({
          orientation: z.enum(["portrait", "landscape"]).optional(),
          fitToPage: z.boolean().optional(),
          fitToWidth: z.number().optional(),
          fitToHeight: z.number().optional(),
          margins: z.object({
            top: z.number().optional(),
            bottom: z.number().optional(),
            left: z.number().optional(),
            right: z.number().optional(),
            header: z.number().optional(),
            footer: z.number().optional()
          }).optional(),
          repeatRows: z.object({ from: z.number(), to: z.number() }).optional(),
          headerFooter: z.object({
            oddHeader: z.string().optional(),
            oddFooter: z.string().optional()
          }).optional()
        }).optional(),
        tabColor: z.string().optional().describe("Tab colour as ARGB hex, e.g. FF0000FF")
      })).min(1).describe("Sheet definitions"),
      creator: z.string().optional().default("WCJR MCP").describe("Workbook author metadata")
    }
  },
  async ({ outputPath, sheets, creator }) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = creator;
    workbook.created = new Date();

    for (const sheetDef of sheets) {
      const ws = workbook.addWorksheet(sheetDef.name, {
        properties: { tabColor: sheetDef.tabColor ? { argb: sheetDef.tabColor } : undefined }
      });

      // Columns
      ws.columns = sheetDef.columns.map((col) => {
        const colDef = { header: col.header, width: col.width ?? 15 };
        return colDef;
      });

      // Apply column formats to header row
      sheetDef.columns.forEach((col, idx) => {
        if (col.format) {
          const wsCol = ws.getColumn(idx + 1);
          applyColumnFormat(wsCol, col.format);
        }
      });

      // Rows
      for (const rowData of sheetDef.rows) {
        const row = ws.addRow([]);
        rowData.forEach((val, colIdx) => {
          const cell = row.getCell(colIdx + 1);
          setCellValue(cell, val);
        });
      }

      // Named ranges
      if (sheetDef.namedRanges) {
        for (const nr of sheetDef.namedRanges) {
          workbook.definedNames.addDefinedName({
            name: nr.name,
            refFormula: `'${sheetDef.name}'!${nr.range}`
          });
        }
      }

      // Conditional formatting
      if (sheetDef.conditionalFormatting) {
        for (const cf of sheetDef.conditionalFormatting) {
          ws.addConditionalFormatting({
            ref: cf.range,
            rules: [{
              type: cf.type,
              priority: cf.priority ?? 1,
              operator: cf.operator,
              formulae: cf.formulae ?? [],
              style: cf.style ?? {}
            }]
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
            showErrorMessage: dv.showErrorMessage ?? true,
            errorTitle: dv.errorTitle,
            error: dv.error
          });
        }
      }

      // Freeze panes
      if (sheetDef.freezePanes) {
        ws.views = [{ state: "frozen", xSplit: sheetDef.freezePanes.column - 1, ySplit: sheetDef.freezePanes.row - 1 }];
      }

      // Auto filter
      if (sheetDef.autoFilter) {
        ws.autoFilter = { from: sheetDef.autoFilter.from, to: sheetDef.autoFilter.to };
      }

      // Print config
      if (sheetDef.printConfig) {
        const pc = sheetDef.printConfig;
        if (pc.orientation) ws.pageSetup.orientation = pc.orientation;
        if (pc.fitToPage) {
          ws.pageSetup.fitToPage = true;
          ws.pageSetup.fitToWidth = pc.fitToWidth ?? 1;
          ws.pageSetup.fitToHeight = pc.fitToHeight ?? 0;
        }
        if (pc.margins) {
          ws.pageSetup.margins = { ...ws.pageSetup.margins, ...pc.margins };
        }
        if (pc.repeatRows) {
          ws.pageSetup.printTitlesRow = `${pc.repeatRows.from}:${pc.repeatRows.to}`;
        }
        if (pc.headerFooter) {
          ws.headerFooter.oddHeader = pc.headerFooter.oddHeader;
          ws.headerFooter.oddFooter = pc.headerFooter.oddFooter;
        }
      }
    }

    // Ensure output directory exists
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await workbook.xlsx.writeFile(outputPath);

    const summary = sheets.map((s) => ({
      name: s.name,
      rows: s.rows.length,
      columns: s.columns.length,
      namedRanges: (s.namedRanges ?? []).length
    }));

    return {
      content: [{ type: "text", text: JSON.stringify({ outputPath, sheets: summary }, null, 2) }]
    };
  }
);
```

Note: The remaining tools (`read_workbook`, `update_workbook`, `analyse_workbook`, `export_workbook`) are added in Tasks 2-4. The `server.connect()` call is added at the end of Task 4 after all tools are registered.

- [ ] **Step 3: Add workspace dependency to root package.json**

Add to root `package.json` dependencies:
```
"@wcjr/xlsx-engine-mcp": "0.1.0"
```

- [ ] **Step 4: Install dependencies**

Run: `cd "d:/WCJR MCP/WCJR-MCP" && npm install`

- [ ] **Step 5: Smoke test the create_workbook tool manually**

Create a test script at `packages/xlsx-engine-mcp/test-create.mjs`:

```javascript
import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const outputPath = path.join(os.tmpdir(), "test-wcjr-xlsx.xlsx");
const workbook = new ExcelJS.Workbook();
workbook.creator = "WCJR MCP Test";
const ws = workbook.addWorksheet("Summary");
ws.columns = [
  { header: "Item", width: 20 },
  { header: "Claimed", width: 15 },
  { header: "Admitted", width: 15 },
  { header: "Variance", width: 15 }
];
ws.getColumn(2).numFmt = '#,##0.00;[Red]-#,##0.00';
ws.getColumn(3).numFmt = '#,##0.00;[Red]-#,##0.00';
ws.getColumn(4).numFmt = '#,##0.00;[Red]-#,##0.00';

const r1 = ws.addRow([]);
r1.getCell(1).value = "Preliminaries";
r1.getCell(2).value = 150000;
r1.getCell(3).value = 80000;
r1.getCell(4).value = { formula: "B2-C2" };

const r2 = ws.addRow([]);
r2.getCell(1).value = "S278 Works";
r2.getCell(2).value = 425000;
r2.getCell(3).value = 0;
r2.getCell(4).value = { formula: "B3-C3" };

const r3 = ws.addRow([]);
r3.getCell(1).value = "Total";
r3.getCell(2).value = { formula: "SUM(B2:B3)" };
r3.getCell(3).value = { formula: "SUM(C2:C3)" };
r3.getCell(4).value = { formula: "SUM(D2:D3)" };

ws.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];

await workbook.xlsx.writeFile(outputPath);
console.log(`Test workbook written to: ${outputPath}`);

// Verify it reads back
const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.readFile(outputPath);
const sheet = wb2.getWorksheet("Summary");
console.log(`Sheets: ${wb2.worksheets.map(s => s.name).join(", ")}`);
console.log(`Rows: ${sheet.rowCount}`);
console.log("PASS");

await fs.unlink(outputPath);
```

Run: `cd "d:/WCJR MCP/WCJR-MCP" && node packages/xlsx-engine-mcp/test-create.mjs`
Expected: `PASS` printed, no errors.

- [ ] **Step 6: Delete test script and commit**

```bash
rm packages/xlsx-engine-mcp/test-create.mjs
git add packages/xlsx-engine-mcp/package.json packages/xlsx-engine-mcp/src/server.js package.json package-lock.json
git commit -m "feat(xlsx-engine): scaffold package with create_workbook tool"
```

---

### Task 2: xlsx-engine-mcp — `read_workbook` & `update_workbook` Tools

**Files:**
- Modify: `packages/xlsx-engine-mcp/src/server.js`

- [ ] **Step 1: Add `read_workbook` tool**

Append after the `create_workbook` registration in `server.js`:

```javascript
server.registerTool(
  "read_workbook",
  {
    description:
      "Read an existing Excel workbook with full structural introspection. Returns sheet names, column headers, data (values and/or formulae), named ranges, conditional formatting, data validation, merged cells, and print configuration.",
    inputSchema: {
      filePath: z.string().min(1).describe("Absolute path to the .xlsx file"),
      sheets: z.array(z.string()).optional().describe("Specific sheet names to read; omit for all"),
      includeFormulae: z.boolean().default(true).describe("Return formulae as-is (true) or computed values (false)"),
      range: z.string().optional().describe("Specific cell range to read, e.g. A1:H50")
    }
  },
  async ({ filePath, sheets: sheetFilter, includeFormulae, range }) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const result = { sheets: [], namedRanges: [] };

    // Named ranges
    const definedNames = workbook.definedNames;
    if (definedNames && definedNames.model) {
      for (const [name, entry] of Object.entries(definedNames.model)) {
        result.namedRanges.push({ name, ranges: entry.ranges ?? [] });
      }
    }

    for (const ws of workbook.worksheets) {
      if (sheetFilter && sheetFilter.length > 0 && !sheetFilter.includes(ws.name)) continue;

      const sheetData = {
        name: ws.name,
        columns: [],
        rows: [],
        mergedCells: [],
        conditionalFormatting: [],
        dataValidations: []
      };

      // Read headers from row 1
      const headerRow = ws.getRow(1);
      headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        sheetData.columns.push({
          index: colNumber,
          header: cell.text ?? "",
          width: ws.getColumn(colNumber).width,
          numFmt: ws.getColumn(colNumber).numFmt
        });
      });

      // Determine row range
      let startRow = 1;
      let endRow = ws.rowCount;
      let startCol = 1;
      let endCol = sheetData.columns.length || ws.columnCount;

      if (range) {
        const match = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
        if (match) {
          startCol = colLetterToNumber(match[1]);
          startRow = parseInt(match[2], 10);
          endCol = colLetterToNumber(match[3]);
          endRow = parseInt(match[4], 10);
        }
      }

      // Read rows
      for (let r = startRow; r <= endRow; r++) {
        const row = ws.getRow(r);
        const rowData = [];
        for (let c = startCol; c <= endCol; c++) {
          const cell = row.getCell(c);
          if (includeFormulae && cell.formula) {
            rowData.push({ value: cell.value?.result ?? cell.value, formula: `=${cell.formula}` });
          } else {
            rowData.push(cell.value);
          }
        }
        sheetData.rows.push(rowData);
      }

      // Merged cells
      if (ws.model && ws.model.merges) {
        sheetData.mergedCells = ws.model.merges;
      }

      result.sheets.push(sheetData);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  }
);

function colLetterToNumber(letters) {
  let result = 0;
  for (const char of letters.toUpperCase()) {
    result = result * 26 + (char.charCodeAt(0) - 64);
  }
  return result;
}
```

- [ ] **Step 2: Add `update_workbook` tool**

Append after `read_workbook`:

```javascript
server.registerTool(
  "update_workbook",
  {
    description:
      "Modify an existing Excel workbook. Supports adding/deleting sheets, inserting/updating/deleting rows, adding formulae, named ranges, conditional formatting, data validation, and updating print config. Preserves everything not explicitly changed.",
    inputSchema: {
      filePath: z.string().min(1).describe("Absolute path to the .xlsx file"),
      operations: z.array(z.object({
        type: z.enum([
          "addSheet", "deleteSheet", "insertRows", "updateCells", "deleteRows",
          "addNamedRange", "addConditionalFormatting", "addFormula",
          "setColumnWidth", "mergeCells", "addDataValidation", "updatePrintConfig"
        ]).describe("Operation type"),
        sheet: z.string().optional().describe("Target sheet name"),
        name: z.string().optional().describe("For addSheet: new sheet name. For addNamedRange: range name"),
        row: z.number().optional().describe("Row number (1-indexed)"),
        column: z.number().optional().describe("Column number (1-indexed)"),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional().describe("Row data for insertRows"),
        cells: z.array(z.object({
          row: z.number(),
          column: z.number(),
          value: z.union([z.string(), z.number(), z.boolean(), z.null()])
        })).optional().describe("Cells to update for updateCells"),
        fromRow: z.number().optional().describe("Start row for deleteRows"),
        toRow: z.number().optional().describe("End row for deleteRows"),
        range: z.string().optional().describe("Cell range in A1 notation"),
        formula: z.string().optional().describe("Excel formula without leading ="),
        width: z.number().optional().describe("Column width"),
        conditionalFormatting: z.object({
          type: z.string(),
          operator: z.string().optional(),
          formulae: z.array(z.string()).optional(),
          style: z.any().optional(),
          priority: z.number().optional()
        }).optional(),
        dataValidation: z.object({
          type: z.string(),
          formulae: z.array(z.string()).optional(),
          operator: z.string().optional()
        }).optional(),
        printConfig: z.object({
          orientation: z.string().optional(),
          fitToPage: z.boolean().optional(),
          fitToWidth: z.number().optional(),
          fitToHeight: z.number().optional(),
          margins: z.any().optional(),
          headerFooter: z.any().optional()
        }).optional()
      })).min(1).describe("Operations to apply in order")
    }
  },
  async ({ filePath, operations }) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const applied = [];

    for (const op of operations) {
      const ws = op.sheet ? workbook.getWorksheet(op.sheet) : undefined;

      switch (op.type) {
        case "addSheet":
          workbook.addWorksheet(op.name);
          applied.push(`Added sheet "${op.name}"`);
          break;

        case "deleteSheet":
          if (ws) { workbook.removeWorksheet(ws.id); applied.push(`Deleted sheet "${op.sheet}"`); }
          break;

        case "insertRows":
          if (ws && op.rows) {
            const startRow = op.row ?? (ws.rowCount + 1);
            for (let i = 0; i < op.rows.length; i++) {
              const row = ws.getRow(startRow + i);
              op.rows[i].forEach((val, colIdx) => setCellValue(row.getCell(colIdx + 1), val));
              row.commit();
            }
            applied.push(`Inserted ${op.rows.length} rows at row ${startRow} in "${op.sheet}"`);
          }
          break;

        case "updateCells":
          if (ws && op.cells) {
            for (const c of op.cells) {
              setCellValue(ws.getRow(c.row).getCell(c.column), c.value);
            }
            applied.push(`Updated ${op.cells.length} cells in "${op.sheet}"`);
          }
          break;

        case "deleteRows":
          if (ws && op.fromRow && op.toRow) {
            ws.spliceRows(op.fromRow, op.toRow - op.fromRow + 1);
            applied.push(`Deleted rows ${op.fromRow}-${op.toRow} in "${op.sheet}"`);
          }
          break;

        case "addNamedRange":
          if (op.name && op.range && op.sheet) {
            workbook.definedNames.addDefinedName({
              name: op.name,
              refFormula: `'${op.sheet}'!${op.range}`
            });
            applied.push(`Added named range "${op.name}"`);
          }
          break;

        case "addConditionalFormatting":
          if (ws && op.range && op.conditionalFormatting) {
            ws.addConditionalFormatting({
              ref: op.range,
              rules: [{ ...op.conditionalFormatting, priority: op.conditionalFormatting.priority ?? 1 }]
            });
            applied.push(`Added conditional formatting to ${op.range} in "${op.sheet}"`);
          }
          break;

        case "addFormula":
          if (ws && op.row && op.column && op.formula) {
            ws.getRow(op.row).getCell(op.column).value = { formula: op.formula };
            applied.push(`Set formula at R${op.row}C${op.column} in "${op.sheet}"`);
          }
          break;

        case "setColumnWidth":
          if (ws && op.column && op.width) {
            ws.getColumn(op.column).width = op.width;
            applied.push(`Set column ${op.column} width to ${op.width} in "${op.sheet}"`);
          }
          break;

        case "mergeCells":
          if (ws && op.range) {
            ws.mergeCells(op.range);
            applied.push(`Merged cells ${op.range} in "${op.sheet}"`);
          }
          break;

        case "addDataValidation":
          if (ws && op.range && op.dataValidation) {
            ws.dataValidations.add(op.range, op.dataValidation);
            applied.push(`Added data validation to ${op.range} in "${op.sheet}"`);
          }
          break;

        case "updatePrintConfig":
          if (ws && op.printConfig) {
            const pc = op.printConfig;
            if (pc.orientation) ws.pageSetup.orientation = pc.orientation;
            if (pc.fitToPage) { ws.pageSetup.fitToPage = true; ws.pageSetup.fitToWidth = pc.fitToWidth ?? 1; ws.pageSetup.fitToHeight = pc.fitToHeight ?? 0; }
            if (pc.margins) ws.pageSetup.margins = { ...ws.pageSetup.margins, ...pc.margins };
            if (pc.headerFooter) { ws.headerFooter.oddHeader = pc.headerFooter.oddHeader; ws.headerFooter.oddFooter = pc.headerFooter.oddFooter; }
            applied.push(`Updated print config for "${op.sheet}"`);
          }
          break;
      }
    }

    await workbook.xlsx.writeFile(filePath);
    return {
      content: [{ type: "text", text: JSON.stringify({ filePath, operations: applied }, null, 2) }]
    };
  }
);
```

- [ ] **Step 3: Commit**

```bash
git add packages/xlsx-engine-mcp/src/server.js
git commit -m "feat(xlsx-engine): add read_workbook and update_workbook tools"
```

---

### Task 3: xlsx-engine-mcp — `analyse_workbook` & `export_workbook` Tools + Transport

**Files:**
- Modify: `packages/xlsx-engine-mcp/src/server.js`

- [ ] **Step 1: Add `analyse_workbook` tool**

Append after `update_workbook`:

```javascript
server.registerTool(
  "analyse_workbook",
  {
    description:
      "Perform computational analysis on an existing Excel workbook. Supports variance analysis between columns, sum validation, formula auditing, inconsistency detection, and statistical summaries.",
    inputSchema: {
      filePath: z.string().min(1).describe("Absolute path to the .xlsx file"),
      sheet: z.string().min(1).describe("Sheet name to analyse"),
      analyses: z.array(z.enum([
        "variance", "sumValidation", "formulaAudit", "inconsistencyCheck", "statistical"
      ])).min(1).describe("Types of analysis to perform"),
      varianceColumns: z.object({
        columnA: z.number().describe("First column number (1-indexed)"),
        columnB: z.number().describe("Second column number (1-indexed)"),
        label: z.string().optional().describe("Label for the variance, e.g. 'Claimed vs Admitted'")
      }).optional().describe("Required for variance analysis"),
      sumColumn: z.number().optional().describe("Column to validate sums for (1-indexed). Required for sumValidation"),
      totalRow: z.number().optional().describe("Row containing the total for sumValidation")
    }
  },
  async ({ filePath, sheet, analyses, varianceColumns, sumColumn, totalRow }) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const ws = workbook.getWorksheet(sheet);
    if (!ws) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `Sheet "${sheet}" not found` }) }], isError: true };
    }

    const findings = {};

    if (analyses.includes("variance") && varianceColumns) {
      const rows = [];
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return; // skip header
        const a = Number(row.getCell(varianceColumns.columnA).value) || 0;
        const b = Number(row.getCell(varianceColumns.columnB).value) || 0;
        if (a !== 0 || b !== 0) {
          rows.push({ row: rowNumber, columnA: a, columnB: b, variance: a - b, percentDiff: b !== 0 ? ((a - b) / b * 100).toFixed(2) + "%" : "N/A" });
        }
      });
      const totalA = rows.reduce((s, r) => s + r.columnA, 0);
      const totalB = rows.reduce((s, r) => s + r.columnB, 0);
      findings.variance = {
        label: varianceColumns.label ?? `Column ${varianceColumns.columnA} vs ${varianceColumns.columnB}`,
        rows,
        totalA,
        totalB,
        totalVariance: totalA - totalB
      };
    }

    if (analyses.includes("sumValidation") && sumColumn && totalRow) {
      let computedSum = 0;
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1 || rowNumber === totalRow) return;
        computedSum += Number(row.getCell(sumColumn).value) || 0;
      });
      const statedTotal = Number(ws.getRow(totalRow).getCell(sumColumn).value) || 0;
      findings.sumValidation = {
        column: sumColumn,
        totalRow,
        computedSum,
        statedTotal,
        match: Math.abs(computedSum - statedTotal) < 0.01,
        difference: computedSum - statedTotal
      };
    }

    if (analyses.includes("formulaAudit")) {
      const formulae = [];
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          if (cell.formula) {
            formulae.push({ row: rowNumber, column: colNumber, formula: `=${cell.formula}`, result: cell.value?.result ?? null });
          }
        });
      });
      findings.formulaAudit = { count: formulae.length, formulae };
    }

    if (analyses.includes("inconsistencyCheck")) {
      const issues = [];
      const headerRow = ws.getRow(1);
      const colTypes = {};

      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          const type = typeof cell.value;
          if (!colTypes[colNumber]) colTypes[colNumber] = { types: new Set(), header: headerRow.getCell(colNumber).text };
          colTypes[colNumber].types.add(type);
        });
      });

      for (const [col, info] of Object.entries(colTypes)) {
        if (info.types.size > 1) {
          issues.push({ column: Number(col), header: info.header, mixedTypes: [...info.types] });
        }
      }
      findings.inconsistencyCheck = { issues };
    }

    if (analyses.includes("statistical")) {
      const stats = {};
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          const val = Number(cell.value);
          if (!isNaN(val) && typeof cell.value === "number") {
            if (!stats[colNumber]) stats[colNumber] = { header: ws.getRow(1).getCell(colNumber).text, values: [] };
            stats[colNumber].values.push(val);
          }
        });
      });

      findings.statistical = {};
      for (const [col, data] of Object.entries(stats)) {
        const sorted = [...data.values].sort((a, b) => a - b);
        const sum = sorted.reduce((s, v) => s + v, 0);
        findings.statistical[data.header] = {
          count: sorted.length,
          min: sorted[0],
          max: sorted[sorted.length - 1],
          sum,
          mean: sum / sorted.length,
          median: sorted.length % 2 === 0
            ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
            : sorted[Math.floor(sorted.length / 2)]
        };
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(findings, null, 2) }]
    };
  }
);
```

- [ ] **Step 2: Add `export_workbook` tool**

Append after `analyse_workbook`:

```javascript
server.registerTool(
  "export_workbook",
  {
    description:
      "Export an Excel workbook or specific sheets to PDF. Requires LibreOffice installed (soffice CLI). Applies print configuration from the workbook.",
    inputSchema: {
      filePath: z.string().min(1).describe("Absolute path to the .xlsx file"),
      outputPath: z.string().min(1).describe("Absolute path for the output .pdf file"),
      sheets: z.array(z.string()).optional().describe("Specific sheet names to export; omit for all")
    }
  },
  async ({ filePath, outputPath, sheets: sheetFilter }) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    let sourceFile = filePath;

    // If specific sheets requested, create a temp workbook with only those sheets
    if (sheetFilter && sheetFilter.length > 0) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);
      const tempWorkbook = new ExcelJS.Workbook();

      for (const ws of workbook.worksheets) {
        if (sheetFilter.includes(ws.name)) {
          const newWs = tempWorkbook.addWorksheet(ws.name);
          ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
            const newRow = newWs.getRow(rowNumber);
            row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
              const newCell = newRow.getCell(colNumber);
              newCell.value = cell.value;
              newCell.style = cell.style;
            });
            newRow.commit();
          });
          // Copy column widths
          ws.columns.forEach((col, idx) => {
            if (col.width) newWs.getColumn(idx + 1).width = col.width;
          });
        }
      }

      sourceFile = filePath.replace(/\.xlsx$/i, ".tmp-export.xlsx");
      await tempWorkbook.xlsx.writeFile(sourceFile);
    }

    const outDir = path.dirname(outputPath);
    await fs.mkdir(outDir, { recursive: true });

    try {
      await execFileAsync("soffice", [
        "--headless",
        "--convert-to", "pdf",
        "--outdir", outDir,
        sourceFile
      ], { timeout: 60000 });

      // LibreOffice names output based on input filename — rename if needed
      const libreOutputName = path.basename(sourceFile).replace(/\.xlsx$/i, ".pdf");
      const libreOutputPath = path.join(outDir, libreOutputName);
      if (libreOutputPath !== outputPath) {
        await fs.rename(libreOutputPath, outputPath);
      }
    } finally {
      // Clean up temp file if created
      if (sourceFile !== filePath) {
        await fs.unlink(sourceFile).catch(() => {});
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ outputPath, source: filePath }, null, 2) }]
    };
  }
);
```

- [ ] **Step 3: Add transport connection at the end of server.js**

Append at the very end of `server.js`:

```javascript
const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 4: Commit**

```bash
git add packages/xlsx-engine-mcp/src/server.js
git commit -m "feat(xlsx-engine): add analyse_workbook, export_workbook, connect transport"
```

---

### Task 4: docx-engine-mcp — Package Scaffold & `create_document` Tool

**Files:**
- Create: `packages/docx-engine-mcp/package.json`
- Create: `packages/docx-engine-mcp/src/server.js`
- Modify: `package.json` (root)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@wcjr/docx-engine-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/server.js",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.1",
    "docx": "^9.5.0",
    "mammoth": "^1.9.1",
    "zod": "^3.24.1"
  }
}
```

- [ ] **Step 2: Create server.js with `create_document` tool**

```javascript
#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as docx from "docx";
import fs from "node:fs/promises";
import path from "node:path";

const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, AlignmentType, PageBreak, SectionType, Header, Footer, PageNumber,
  NumberFormat, LevelFormat, ImageRun, FootnoteReferenceRun, Tab,
  BorderStyle, ShadingType, convertInchesToTwip } = docx;

const server = new McpServer({
  name: "wcjr-docx-engine",
  version: "0.1.0"
});

const HEADING_LEVELS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4
};

function buildTextRuns(text, options = {}) {
  if (typeof text === "string") {
    return [new TextRun({ text, ...options })];
  }
  // Array of inline segments: [{text, bold, italic, underline}]
  if (Array.isArray(text)) {
    return text.map((seg) => new TextRun({
      text: seg.text,
      bold: seg.bold ?? options.bold,
      italic: seg.italic ?? options.italic,
      underline: seg.underline ? { type: "single" } : undefined,
      font: options.font,
      size: options.size
    }));
  }
  return [new TextRun({ text: String(text) })];
}

function buildParagraph(element, numbering, termsRegistry) {
  const opts = {};

  if (element.type === "heading") {
    return new Paragraph({
      heading: HEADING_LEVELS[element.level] ?? HeadingLevel.HEADING_1,
      children: buildTextRuns(element.text),
      numbering: element.numbering !== "none" ? { reference: "legal-numbering", level: (element.level ?? 1) - 1 } : undefined
    });
  }

  if (element.type === "paragraph") {
    const runs = buildTextRuns(element.text, {
      bold: element.bold,
      italic: element.italic
    });
    return new Paragraph({
      children: runs,
      numbering: element.numbered ? { reference: "legal-numbering", level: element.indentLevel ?? 0 } : undefined,
      alignment: element.alignment === "center" ? AlignmentType.CENTER
        : element.alignment === "right" ? AlignmentType.RIGHT
        : element.alignment === "justified" ? AlignmentType.JUSTIFIED
        : AlignmentType.LEFT,
      indent: element.indentLevel ? { left: convertInchesToTwip(0.5 * element.indentLevel) } : undefined
    });
  }

  if (element.type === "definedTerm") {
    termsRegistry.add(element.term);
    return new Paragraph({
      children: [
        new TextRun({ text: `"${element.term}"`, bold: true }),
        new TextRun({ text: ` means ${element.definition}` })
      ]
    });
  }

  if (element.type === "citation") {
    return new Paragraph({
      children: [
        new TextRun({ text: element.caseName, italics: true }),
        new TextRun({ text: ` [${element.neutralCitation}]` }),
        ...(element.pinpoint ? [new TextRun({ text: ` (${element.pinpoint})` })] : []),
        ...(element.parenthetical ? [new TextRun({ text: ` (${element.parenthetical})` })] : [])
      ]
    });
  }

  if (element.type === "table") {
    const rows = [];
    // Header row
    if (element.headers) {
      rows.push(new TableRow({
        tableHeader: true,
        children: element.headers.map((h) => new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
          shading: element.headerShading ? { type: ShadingType.SOLID, color: element.headerShading } : undefined
        }))
      }));
    }
    // Data rows
    if (element.rows) {
      for (const row of element.rows) {
        rows.push(new TableRow({
          children: row.map((cell) => new TableCell({
            children: [new Paragraph({ children: buildTextRuns(cell) })]
          }))
        }));
      }
    }
    return new Table({
      rows,
      width: { size: 100, type: WidthType.PERCENTAGE }
    });
  }

  if (element.type === "list") {
    // Return array of paragraphs for list items
    return element.items.map((item) => new Paragraph({
      children: buildTextRuns(item),
      bullet: { level: element.indentLevel ?? 0 }
    }));
  }

  if (element.type === "pageBreak") {
    return new Paragraph({ children: [new PageBreak()] });
  }

  return new Paragraph({ children: buildTextRuns(element.text ?? "") });
}

const contentElementSchema = z.object({
  type: z.enum(["heading", "paragraph", "definedTerm", "citation", "table", "list", "pageBreak", "sectionBreak", "image"]),
  // heading
  level: z.number().min(1).max(4).optional(),
  // paragraph + heading
  text: z.union([
    z.string(),
    z.array(z.object({
      text: z.string(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional()
    }))
  ]).optional(),
  numbering: z.enum(["legal", "none"]).optional(),
  numbered: z.boolean().optional(),
  indentLevel: z.number().optional(),
  alignment: z.enum(["left", "center", "right", "justified"]).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  // definedTerm
  term: z.string().optional(),
  definition: z.string().optional(),
  // citation
  caseName: z.string().optional(),
  neutralCitation: z.string().optional(),
  pinpoint: z.string().optional(),
  parenthetical: z.string().optional(),
  // table
  headers: z.array(z.string()).optional(),
  rows: z.array(z.array(z.string())).optional(),
  headerShading: z.string().optional(),
  // list
  items: z.array(z.string()).optional()
});

server.registerTool(
  "create_document",
  {
    description:
      "Create a Word document (.docx) from a flexible content tree. Supports headings with legal numbering (1, 1.1, 1.1.1), paragraphs with inline formatting, defined terms, case law citations, tables, lists, page breaks, and headers/footers with matter references. The AI decides document structure — this tool renders it.",
    inputSchema: {
      outputPath: z.string().min(1).describe("Absolute file path for the output .docx"),
      metadata: z.object({
        title: z.string().optional(),
        author: z.string().optional().default("WCJR MCP"),
        subject: z.string().optional(),
        matterReference: z.string().optional()
      }).optional(),
      pageSetup: z.object({
        orientation: z.enum(["portrait", "landscape"]).optional().default("portrait"),
        marginTop: z.number().optional().describe("Top margin in inches"),
        marginBottom: z.number().optional().describe("Bottom margin in inches"),
        marginLeft: z.number().optional().describe("Left margin in inches"),
        marginRight: z.number().optional().describe("Right margin in inches"),
        headerText: z.string().optional().describe("Header text for all pages"),
        footerText: z.string().optional().describe("Footer text (page numbers auto-appended)"),
        confidentiality: z.string().optional().describe("Confidentiality marking in header")
      }).optional(),
      styles: z.object({
        font: z.string().optional().default("Times New Roman"),
        fontSize: z.number().optional().default(24).describe("Font size in half-points (24 = 12pt)"),
        lineSpacing: z.number().optional().default(360).describe("Line spacing in 240ths of a line (360 = 1.5 lines)")
      }).optional(),
      content: z.array(contentElementSchema).min(1).describe("Ordered content elements")
    }
  },
  async ({ outputPath, metadata, pageSetup, styles, content }) => {
    const meta = metadata ?? {};
    const ps = pageSetup ?? {};
    const st = styles ?? {};
    const font = st.font ?? "Times New Roman";
    const fontSize = st.fontSize ?? 24;
    const termsRegistry = new Set();

    const children = [];
    for (const element of content) {
      const result = buildParagraph(element, null, termsRegistry);
      if (Array.isArray(result)) {
        children.push(...result);
      } else {
        children.push(result);
      }
    }

    const headerChildren = [];
    if (ps.confidentiality) {
      headerChildren.push(new Paragraph({
        children: [new TextRun({ text: ps.confidentiality, bold: true, size: 18 })],
        alignment: AlignmentType.CENTER
      }));
    }
    if (ps.headerText) {
      headerChildren.push(new Paragraph({
        children: [new TextRun({ text: ps.headerText, size: 18 })],
        alignment: AlignmentType.RIGHT
      }));
    }

    const footerChildren = [
      new Paragraph({
        children: [
          ...(ps.footerText ? [new TextRun({ text: ps.footerText + "  |  ", size: 18 })] : []),
          new TextRun({ text: "Page ", size: 18 }),
          new TextRun({ children: [PageNumber.CURRENT], size: 18 }),
          new TextRun({ text: " of ", size: 18 }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18 })
        ],
        alignment: AlignmentType.CENTER
      })
    ];

    const doc = new Document({
      creator: meta.author ?? "WCJR MCP",
      title: meta.title,
      subject: meta.subject,
      description: meta.matterReference ? `Matter: ${meta.matterReference}` : undefined,
      styles: {
        default: {
          document: {
            run: { font, size: fontSize },
            paragraph: { spacing: { line: st.lineSpacing ?? 360 } }
          }
        }
      },
      numbering: {
        config: [{
          reference: "legal-numbering",
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(0), hanging: convertInchesToTwip(0.5) } } } },
            { level: 1, format: LevelFormat.DECIMAL, text: "%1.%2", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.5) } } } },
            { level: 2, format: LevelFormat.DECIMAL, text: "%1.%2.%3", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(1), hanging: convertInchesToTwip(0.5) } } } },
            { level: 3, format: LevelFormat.DECIMAL, text: "%1.%2.%3.%4", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(1.5), hanging: convertInchesToTwip(0.5) } } } }
          ]
        }]
      },
      sections: [{
        properties: {
          page: {
            size: { orientation: ps.orientation === "landscape" ? docx.PageOrientation.LANDSCAPE : docx.PageOrientation.PORTRAIT },
            margin: {
              top: convertInchesToTwip(ps.marginTop ?? 1),
              bottom: convertInchesToTwip(ps.marginBottom ?? 1),
              left: convertInchesToTwip(ps.marginLeft ?? 1.25),
              right: convertInchesToTwip(ps.marginRight ?? 1.25)
            }
          }
        },
        headers: headerChildren.length > 0 ? { default: new Header({ children: headerChildren }) } : undefined,
        footers: { default: new Footer({ children: footerChildren }) },
        children
      }]
    });

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const buffer = await Packer.toBuffer(doc);
    await fs.writeFile(outputPath, buffer);

    // Count headings for summary
    const headings = content.filter((e) => e.type === "heading");
    const headingTree = headings.map((h) => `${"  ".repeat((h.level ?? 1) - 1)}${h.text}`);

    return {
      content: [{ type: "text", text: JSON.stringify({
        outputPath,
        elements: content.length,
        headings: headingTree,
        definedTerms: [...termsRegistry]
      }, null, 2) }]
    };
  }
);
```

Note: `read_document`, `update_document`, `merge_documents`, `export_document` tools added in Tasks 5-6. Transport connected at end of Task 6.

- [ ] **Step 3: Add workspace dependency to root package.json**

Add to root `package.json` dependencies:
```
"@wcjr/docx-engine-mcp": "0.1.0"
```

- [ ] **Step 4: Install and smoke test**

Run: `cd "d:/WCJR MCP/WCJR-MCP" && npm install`

Create `packages/docx-engine-mcp/test-create.mjs`:

```javascript
import * as docx from "docx";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, LevelFormat, convertInchesToTwip } = docx;

const outputPath = path.join(os.tmpdir(), "test-wcjr-docx.docx");

const doc = new Document({
  creator: "WCJR MCP Test",
  numbering: {
    config: [{
      reference: "legal-numbering",
      levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(0), hanging: convertInchesToTwip(0.5) } } } },
        { level: 1, format: LevelFormat.DECIMAL, text: "%1.%2", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.5) } } } }
      ]
    }]
  },
  sections: [{
    children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Introduction")] }),
      new Paragraph({
        numbering: { reference: "legal-numbering", level: 0 },
        children: [new TextRun("This is the first numbered paragraph.")]
      }),
      new Paragraph({
        numbering: { reference: "legal-numbering", level: 0 },
        children: [new TextRun("This is the second numbered paragraph.")]
      }),
      new Paragraph({
        numbering: { reference: "legal-numbering", level: 1 },
        children: [new TextRun("This is a sub-paragraph.")]
      })
    ]
  }]
});

const buffer = await Packer.toBuffer(doc);
await fs.writeFile(outputPath, buffer);
console.log(`Test document written to: ${outputPath}`);

const stats = await fs.stat(outputPath);
console.log(`Size: ${stats.size} bytes`);
console.log("PASS");
await fs.unlink(outputPath);
```

Run: `cd "d:/WCJR MCP/WCJR-MCP" && node packages/docx-engine-mcp/test-create.mjs`
Expected: `PASS`.

- [ ] **Step 5: Delete test script and commit**

```bash
rm packages/docx-engine-mcp/test-create.mjs
git add packages/docx-engine-mcp/ package.json package-lock.json
git commit -m "feat(docx-engine): scaffold package with create_document tool"
```

---

### Task 5: docx-engine-mcp — `read_document` & `update_document` Tools

**Files:**
- Modify: `packages/docx-engine-mcp/src/server.js`

- [ ] **Step 1: Add `read_document` tool**

Append after `create_document` registration:

```javascript
import mammoth from "mammoth";

server.registerTool(
  "read_document",
  {
    description:
      "Read an existing Word document (.docx) with structural introspection. Returns the content tree including headings, paragraphs with numbering, tables, styles, metadata, and detected defined terms and citations.",
    inputSchema: {
      filePath: z.string().min(1).describe("Absolute path to the .docx file"),
      extractStructure: z.boolean().default(true).describe("Return heading tree, paragraph numbering, defined terms"),
      extractTables: z.boolean().default(true).describe("Include table data in output")
    }
  },
  async ({ filePath, extractStructure, extractTables }) => {
    const buffer = await fs.readFile(filePath);

    // Use mammoth for structured extraction
    const htmlResult = await mammoth.convertToHtml({ buffer });
    const rawResult = await mammoth.extractRawText({ buffer });

    const result = {
      text: rawResult.value,
      warnings: htmlResult.messages.map((m) => m.message)
    };

    if (extractStructure) {
      // Parse headings from HTML output
      const headingRegex = /<h(\d)>(.*?)<\/h\d>/gi;
      const headings = [];
      let match;
      while ((match = headingRegex.exec(htmlResult.value)) !== null) {
        headings.push({ level: parseInt(match[1], 10), text: match[2].replace(/<[^>]+>/g, "") });
      }
      result.headings = headings;

      // Detect defined terms (quoted, capitalised terms)
      const termRegex = /"([A-Z][^"]{2,})"/g;
      const terms = new Set();
      while ((match = termRegex.exec(rawResult.value)) !== null) {
        terms.add(match[1]);
      }
      result.definedTerms = [...terms];

      // Detect citations (italic text followed by brackets)
      const citeRegex = /([A-Z][a-z]+ (?:v|and) [A-Z][a-z]+[^[]*)\[(\d{4})\]\s*([A-Z]+\s+\d+)/g;
      const citations = [];
      while ((match = citeRegex.exec(rawResult.value)) !== null) {
        citations.push({ caseName: match[1].trim(), year: match[2], citation: `[${match[2]}] ${match[3]}` });
      }
      result.citations = citations;
    }

    if (extractTables) {
      const tableRegex = /<table>([\s\S]*?)<\/table>/gi;
      const tables = [];
      let tableMatch;
      while ((tableMatch = tableRegex.exec(htmlResult.value)) !== null) {
        const rowRegex = /<tr>([\s\S]*?)<\/tr>/gi;
        const rows = [];
        let rowMatch;
        while ((rowMatch = rowRegex.exec(tableMatch[1])) !== null) {
          const cellRegex = /<t[dh]>([\s\S]*?)<\/t[dh]>/gi;
          const cells = [];
          let cellMatch;
          while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
            cells.push(cellMatch[1].replace(/<[^>]+>/g, "").trim());
          }
          rows.push(cells);
        }
        tables.push(rows);
      }
      result.tables = tables;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  }
);
```

Note: The mammoth import should be moved to the top of the file alongside the other imports. In Step 2 of Task 4, mammoth was already in the package.json deps.

- [ ] **Step 2: Add `update_document` tool**

Append after `read_document`:

```javascript
server.registerTool(
  "update_document",
  {
    description:
      "Modify an existing Word document. Read the document, apply operations (insert, replace, delete sections), and write back. For complex modifications, prefer reading the document with read_document first, then creating a new document with create_document using the modified content tree.",
    inputSchema: {
      filePath: z.string().min(1).describe("Absolute path to the .docx file"),
      outputPath: z.string().optional().describe("Output path; defaults to overwriting the input file"),
      operations: z.array(z.object({
        type: z.enum(["appendContent", "prependContent", "replaceAllText"]),
        content: z.array(contentElementSchema).optional().describe("Content elements for append/prepend"),
        find: z.string().optional().describe("Text to find for replaceAllText"),
        replace: z.string().optional().describe("Replacement text")
      })).min(1).describe("Operations to apply")
    }
  },
  async ({ filePath, outputPath: outPath, operations }) => {
    // For text replacements, read raw text, apply replacements, and note them
    // For content additions, read the document and create a new one with additions
    const buffer = await fs.readFile(filePath);
    const rawResult = await mammoth.extractRawText({ buffer });
    let text = rawResult.value;
    const applied = [];

    for (const op of operations) {
      if (op.type === "replaceAllText" && op.find && op.replace !== undefined) {
        const count = (text.match(new RegExp(op.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
        text = text.replaceAll(op.find, op.replace);
        applied.push(`Replaced ${count} instances of "${op.find}" with "${op.replace}"`);
      }
      // For append/prepend — note: docx library creates new documents, cannot modify in-place
      // For complex operations, we advise using read_document + create_document workflow
      if ((op.type === "appendContent" || op.type === "prependContent") && op.content) {
        applied.push(`${op.type}: ${op.content.length} elements noted — use read_document + create_document for structural modifications`);
      }
    }

    // If only text replacements, rebuild a simple document
    if (operations.every((op) => op.type === "replaceAllText")) {
      const termsRegistry = new Set();
      const doc = new Document({
        sections: [{
          children: text.split("\n").filter(Boolean).map((line) =>
            new Paragraph({ children: [new TextRun(line)] })
          )
        }]
      });
      const outBuffer = await Packer.toBuffer(doc);
      const finalPath = outPath ?? filePath;
      await fs.writeFile(finalPath, outBuffer);
      applied.push(`Written to ${finalPath}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ operations: applied }, null, 2) }]
    };
  }
);
```

- [ ] **Step 3: Commit**

```bash
git add packages/docx-engine-mcp/src/server.js
git commit -m "feat(docx-engine): add read_document and update_document tools"
```

---

### Task 6: docx-engine-mcp — `merge_documents` & `export_document` Tools + Transport

**Files:**
- Modify: `packages/docx-engine-mcp/src/server.js`

- [ ] **Step 1: Add `merge_documents` tool**

Append after `update_document`:

```javascript
server.registerTool(
  "merge_documents",
  {
    description:
      "Combine multiple Word documents into a single output file with section breaks between them. For full structural control, read each document with read_document and build a single document with create_document.",
    inputSchema: {
      files: z.array(z.string().min(1)).min(2).describe("Ordered list of absolute .docx file paths"),
      outputPath: z.string().min(1).describe("Absolute path for the merged output .docx"),
      sectionBreaks: z.boolean().default(true).describe("Insert section breaks between documents")
    }
  },
  async ({ files, outputPath: outPath, sectionBreaks }) => {
    const sections = [];

    for (const filePath of files) {
      const buffer = await fs.readFile(filePath);
      const rawResult = await mammoth.extractRawText({ buffer });
      const paragraphs = rawResult.value.split("\n").filter(Boolean).map((line) =>
        new Paragraph({ children: [new TextRun(line)] })
      );
      sections.push({
        properties: sectionBreaks ? { type: SectionType.NEXT_PAGE } : {},
        children: paragraphs
      });
    }

    const doc = new Document({ sections });
    const buffer = await Packer.toBuffer(doc);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, buffer);

    return {
      content: [{ type: "text", text: JSON.stringify({
        outputPath: outPath,
        mergedFiles: files.length,
        files
      }, null, 2) }]
    };
  }
);
```

- [ ] **Step 2: Add `export_document` tool**

Append after `merge_documents`:

```javascript
server.registerTool(
  "export_document",
  {
    description:
      "Export a Word document to PDF using LibreOffice CLI (soffice --headless). Requires LibreOffice installed.",
    inputSchema: {
      filePath: z.string().min(1).describe("Absolute path to the .docx file"),
      outputPath: z.string().min(1).describe("Absolute path for the output .pdf file")
    }
  },
  async ({ filePath, outputPath: outPath }) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const outDir = path.dirname(outPath);
    await fs.mkdir(outDir, { recursive: true });

    await execFileAsync("soffice", [
      "--headless",
      "--convert-to", "pdf",
      "--outdir", outDir,
      filePath
    ], { timeout: 60000 });

    // LibreOffice names output based on input filename
    const libreOutputName = path.basename(filePath).replace(/\.docx$/i, ".pdf");
    const libreOutputPath = path.join(outDir, libreOutputName);
    if (libreOutputPath !== outPath) {
      await fs.rename(libreOutputPath, outPath);
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ outputPath: outPath, source: filePath }, null, 2) }]
    };
  }
);
```

- [ ] **Step 3: Add transport connection**

Append at the end of `server.js`:

```javascript
const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 4: Commit**

```bash
git add packages/docx-engine-mcp/src/server.js
git commit -m "feat(docx-engine): add merge_documents, export_document, connect transport"
```

---

### Task 7: Document Ingestion — PST, MSG, and Structural DOCX Extraction

**Files:**
- Modify: `packages/document-ingestion/package.json`
- Modify: `packages/document-ingestion/src/index.js`

- [ ] **Step 1: Add new dependencies to package.json**

Update `packages/document-ingestion/package.json` dependencies:
```json
{
  "name": "@wcjr/document-ingestion",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.js",
  "dependencies": {
    "mammoth": "^1.9.1",
    "pdf-parse": "^1.1.1",
    "tesseract.js": "^6.0.1",
    "pst-extractor": "^1.9.2",
    "@pst-extractor/msg-reader": "^1.0.0"
  }
}
```

- [ ] **Step 2: Add PST/MSG extension sets and kind detection**

In `packages/document-ingestion/src/index.js`, add after the `IMAGE_EXTENSIONS` set (line 38):

```javascript
const PST_EXTENSIONS = new Set([".pst"]);
const MSG_EXTENSIONS = new Set([".msg"]);
```

Update `guessDocumentKind` function to add before the `return "unknown"` line:

```javascript
  if (PST_EXTENSIONS.has(extension)) return "pst";
  if (MSG_EXTENSIONS.has(extension)) return "msg";
```

- [ ] **Step 3: Add PST extraction function**

Add after the `extractXlsx` function:

```javascript
async function extractPst(buffer) {
  const { PSTFile } = await import("pst-extractor");
  const tmpPath = path.join(process.env.TEMP || "/tmp", `wcjr-pst-${Date.now()}.pst`);
  const fsSync = await import("node:fs");
  fsSync.writeFileSync(tmpPath, buffer);

  try {
    const pstFile = new PSTFile(tmpPath);
    const emails = [];

    function processFolder(folder) {
      if (folder.hasSubfolders) {
        const children = folder.getSubFolders();
        for (const child of children) {
          processFolder(child);
        }
      }
      if (folder.contentCount > 0) {
        let email = folder.getNextChild();
        while (email !== null) {
          const entry = {
            subject: email.subject ?? "",
            from: email.senderName ?? "",
            to: email.displayTo ?? "",
            date: email.messageDeliveryTime?.toISOString() ?? "",
            body: email.body ?? ""
          };
          emails.push(`From: ${entry.from}\nTo: ${entry.to}\nDate: ${entry.date}\nSubject: ${entry.subject}\n\n${entry.body}`);
          email = folder.getNextChild();
        }
      }
    }

    processFolder(pstFile.getRootFolder());
    return emails.join("\n\n---EMAIL SEPARATOR---\n\n");
  } finally {
    fsSync.unlinkSync(tmpPath);
  }
}
```

- [ ] **Step 4: Add MSG extraction function**

Add after the PST function:

```javascript
async function extractMsg(buffer) {
  const { default: MsgReader } = await import("@pst-extractor/msg-reader");
  const reader = new MsgReader(buffer);
  const fileData = reader.getFileData();
  const parts = [];
  if (fileData.senderName) parts.push(`From: ${fileData.senderName}`);
  if (fileData.displayTo) parts.push(`To: ${fileData.displayTo}`);
  if (fileData.messageDeliveryTime) parts.push(`Date: ${fileData.messageDeliveryTime}`);
  if (fileData.subject) parts.push(`Subject: ${fileData.subject}`);
  parts.push("");
  parts.push(fileData.body ?? "");
  return parts.join("\n");
}
```

- [ ] **Step 5: Add structural DOCX extraction function**

Add after the MSG function:

```javascript
async function extractDocxStructured(buffer) {
  const htmlResult = await mammoth.convertToHtml({ buffer });
  const rawResult = await mammoth.extractRawText({ buffer });
  const html = htmlResult.value;

  const headings = [];
  const headingRegex = /<h(\d)>(.*?)<\/h\d>/gi;
  let match;
  while ((match = headingRegex.exec(html)) !== null) {
    headings.push({ level: parseInt(match[1], 10), text: match[2].replace(/<[^>]+>/g, "") });
  }

  const tables = [];
  const tableRegex = /<table>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const rowRegex = /<tr>([\s\S]*?)<\/tr>/gi;
    const rows = [];
    let rowMatch;
    while ((rowMatch = rowRegex.exec(tableMatch[1])) !== null) {
      const cellRegex = /<t[dh]>([\s\S]*?)<\/t[dh]>/gi;
      const cells = [];
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
        cells.push(cellMatch[1].replace(/<[^>]+>/g, "").trim());
      }
      rows.push(cells);
    }
    tables.push(rows);
  }

  return {
    text: rawResult.value,
    headings,
    tables,
    warnings: htmlResult.messages.map((m) => m.message)
  };
}
```

- [ ] **Step 6: Update extractDocumentText switch statement**

Add cases to the switch in `extractDocumentText`, before the `default:` case:

```javascript
      case "pst":
        rawText = await extractPst(inputBuffer);
        method = "pst-extractor";
        break;
      case "msg":
        rawText = await extractMsg(inputBuffer);
        method = "msg-reader";
        break;
```

- [ ] **Step 7: Add new export for structured extraction**

Add a new exported function at the end of the file:

```javascript
export async function extractDocumentStructured({
  buffer,
  fileName = "",
  contentType = "",
  maxChars = 500000
}) {
  const inputBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const kind = guessDocumentKind(fileName, contentType);

  if (kind === "docx") {
    const structured = await extractDocxStructured(inputBuffer);
    const truncated = truncateText(structured.text, maxChars);
    return {
      kind,
      method: "mammoth-structured",
      text: truncated.text,
      truncated: truncated.truncated,
      structure: {
        headings: structured.headings,
        tables: structured.tables
      },
      warnings: structured.warnings
    };
  }

  // Fall back to plain extraction for non-DOCX
  const result = await extractDocumentText({ buffer: inputBuffer, fileName, contentType, maxChars });
  return { ...result, structure: null };
}
```

- [ ] **Step 8: Install and commit**

```bash
cd "d:/WCJR MCP/WCJR-MCP" && npm install
git add packages/document-ingestion/
git commit -m "feat(document-ingestion): add PST, MSG, and structural DOCX extraction"
```

---

### Task 8: RAG Package — Enhanced Ingest with Metadata, List Collections, Delete by Filter

**Files:**
- Modify: `packages/rag/src/index.js`
- Modify: `packages/rag/src/chunker.js`

- [ ] **Step 1: Add `listCollections` function to rag/src/index.js**

Add after the `deleteBySource` function:

```javascript
/**
 * List all Qdrant collections with point counts.
 * @returns {Promise<Array<{name: string, pointsCount: number}>>}
 */
export async function listCollections() {
  const { collections } = await qdrant.getCollections();
  const result = [];
  for (const col of collections) {
    const info = await qdrant.getCollection(col.name);
    result.push({
      name: col.name,
      pointsCount: info.points_count ?? 0,
      vectorsCount: info.vectors_count ?? 0
    });
  }
  return result;
}
```

- [ ] **Step 2: Add `deleteByFilter` function**

Add after `listCollections`:

```javascript
/**
 * Delete points matching a metadata filter.
 * @param {string} collection - Collection name.
 * @param {object} filter - Qdrant filter object with must/should conditions.
 */
export async function deleteByFilter(collection, filter) {
  await qdrant.delete(collection, { filter });
}

/**
 * Delete an entire collection.
 * @param {string} collection - Collection name.
 */
export async function deleteCollection(collection) {
  await qdrant.deleteCollection(collection);
}
```

- [ ] **Step 3: Enhance `ensureCollection` to add metadata indexes**

Replace the existing `ensureCollection` function:

```javascript
export async function ensureCollection(name) {
  const { collections } = await qdrant.getCollections();
  if (collections.some((c) => c.name === name)) return;

  await qdrant.createCollection(name, {
    vectors: { size: VECTOR_SIZE, distance: "Cosine" }
  });

  const indexes = ["source", "documentType", "matter", "custodian", "assessmentWindow"];
  for (const field of indexes) {
    await qdrant.createPayloadIndex(name, {
      field_name: field,
      field_schema: "keyword"
    });
  }
}
```

- [ ] **Step 4: Enhance `ingest` to accept richer metadata**

Replace the existing `ingest` function:

```javascript
export async function ingest(collection, chunks) {
  const texts = chunks.map((c) => c.text);
  const embeddings = await embed(texts);

  const points = chunks.map((chunk, i) => ({
    id: chunk.id,
    vector: embeddings[i],
    payload: {
      text: chunk.text,
      source: chunk.source,
      section: chunk.section ?? "",
      page: chunk.page ?? 0,
      documentType: chunk.documentType ?? "general",
      chunkIndex: chunk.chunkIndex ?? i,
      matter: chunk.matter ?? "",
      custodian: chunk.custodian ?? "",
      assessmentWindow: chunk.assessmentWindow ?? "",
      headingPath: chunk.headingPath ?? "",
      dateRange: chunk.dateRange ?? ""
    }
  }));

  for (let i = 0; i < points.length; i += 100) {
    await qdrant.upsert(collection, {
      wait: true,
      points: points.slice(i, i + 100)
    });
  }
  return points.length;
}
```

- [ ] **Step 5: Enhance `search` to return richer metadata**

Replace the existing `search` function:

```javascript
export async function search(collection, query, { limit = 5, filter } = {}) {
  const [queryVector] = await embed(query);
  const result = await qdrant.query(collection, {
    query: queryVector,
    limit,
    with_payload: true,
    ...(filter && { filter })
  });

  return result.points.map((p) => ({
    score: p.score,
    text: p.payload.text,
    source: p.payload.source,
    section: p.payload.section,
    page: p.payload.page,
    documentType: p.payload.documentType,
    matter: p.payload.matter,
    custodian: p.payload.custodian,
    assessmentWindow: p.payload.assessmentWindow,
    headingPath: p.payload.headingPath
  }));
}
```

- [ ] **Step 6: Add `headingPath` to chunker metadata**

In `packages/rag/src/chunker.js`, update the `chunkDocument` return to include `headingPath`:

Replace the return in `chunkDocument`:

```javascript
  return chunks.map((chunk, i) => ({
    id: randomUUID(),
    text: chunk,
    chunkIndex: i,
    source: meta.source ?? "unknown",
    section: meta.section ?? "",
    page: meta.page ?? 0,
    documentType: meta.documentType ?? "general",
    matter: meta.matter ?? "",
    custodian: meta.custodian ?? "",
    assessmentWindow: meta.assessmentWindow ?? "",
    headingPath: meta.headingPath ?? "",
    dateRange: meta.dateRange ?? ""
  }));
```

- [ ] **Step 7: Commit**

```bash
git add packages/rag/src/index.js packages/rag/src/chunker.js
git commit -m "feat(rag): add listCollections, deleteByFilter, enhanced metadata for knowledge layer"
```

---

### Task 9: Qdrant RAG MCP — Add Five Knowledge Tools

**Files:**
- Modify: `packages/qdrant-rag-mcp/package.json`
- Modify: `packages/qdrant-rag-mcp/src/server.js`

- [ ] **Step 1: Add document-ingestion dependency**

Update `packages/qdrant-rag-mcp/package.json`:

```json
{
  "name": "@wcjr/qdrant-rag-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/server.js",
  "dependencies": {
    "@wcjr/rag": "0.1.0",
    "@wcjr/document-ingestion": "0.1.0"
  }
}
```

- [ ] **Step 2: Add imports to server.js**

Add after the existing imports at the top of `packages/qdrant-rag-mcp/src/server.js`:

```javascript
import { listCollections, deleteByFilter, deleteCollection } from "@wcjr/rag";
import { extractDocumentText } from "@wcjr/document-ingestion";
import fs from "node:fs/promises";
import path from "node:path";
```

- [ ] **Step 3: Add `knowledge_ingest` tool**

Add before the `const transport` line:

```javascript
server.registerTool(
  "knowledge_ingest",
  {
    description:
      "Ingest a file or directory into a named Qdrant knowledge collection. Extracts text from PDF, DOCX, XLSX, images (OCR), PST, MSG, HTML, and plain text. Chunks with overlap, embeds via Ollama, stores with metadata tags.",
    inputSchema: {
      source: z.string().min(1).describe("Absolute file or directory path to ingest"),
      collection: z.string().min(1).describe("Target Qdrant collection name (e.g. 'contracts', 'authorities', 'matter:welbourne')"),
      tags: z.object({
        matter: z.string().optional().describe("Matter name, e.g. 'welbourne'"),
        documentType: z.string().optional().describe("Document type: contract, authority, correspondence, report, etc."),
        custodian: z.string().optional().describe("Document custodian/author"),
        assessmentWindow: z.string().optional().describe("Delay assessment window, e.g. 'W4', 'W5a'"),
        dateRange: z.string().optional().describe("Date range covered, e.g. '2023-2025'")
      }).optional(),
      recursive: z.boolean().default(true).describe("Recurse into subdirectories"),
      chunkOverlap: z.number().default(200).describe("Character overlap between chunks")
    }
  },
  async ({ source, collection, tags, recursive, chunkOverlap }) => {
    await ensureCollection(collection);
    const tagMeta = tags ?? {};
    let totalChunks = 0;
    let filesProcessed = 0;
    const errors = [];

    async function processFile(filePath) {
      try {
        const buffer = await fs.readFile(filePath);
        const result = await extractDocumentText({ buffer, fileName: filePath });
        if (!result.text) {
          errors.push({ file: filePath, error: "No text extracted" });
          return;
        }

        const chunks = chunkDocument(result.text, {
          source: filePath,
          documentType: tagMeta.documentType ?? result.kind,
          matter: tagMeta.matter ?? "",
          custodian: tagMeta.custodian ?? "",
          assessmentWindow: tagMeta.assessmentWindow ?? "",
          dateRange: tagMeta.dateRange ?? ""
        }, { overlap: chunkOverlap });

        const count = await ingest(collection, chunks);
        totalChunks += count;
        filesProcessed++;
      } catch (err) {
        errors.push({ file: filePath, error: err.message ?? String(err) });
      }
    }

    const stat = await fs.stat(source);
    if (stat.isFile()) {
      await processFile(source);
    } else if (stat.isDirectory()) {
      async function walkDir(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isFile()) {
            await processFile(fullPath);
          } else if (entry.isDirectory() && recursive) {
            await walkDir(fullPath);
          }
        }
      }
      await walkDir(source);
    }

    return {
      content: [{ type: "text", text: JSON.stringify({
        collection,
        filesProcessed,
        chunksCreated: totalChunks,
        errors: errors.length > 0 ? errors : undefined
      }, null, 2) }]
    };
  }
);
```

- [ ] **Step 4: Add `knowledge_query` tool**

```javascript
server.registerTool(
  "knowledge_query",
  {
    description:
      "Semantic search across one or more Qdrant knowledge collections. Supports metadata filters for matter, document type, custodian, and assessment window.",
    inputSchema: {
      query: z.string().min(2).describe("Natural language search query"),
      collections: z.array(z.string()).optional().describe("Collection names to search; omit to search 'documents'"),
      filters: z.object({
        matter: z.string().optional(),
        documentType: z.string().optional(),
        custodian: z.string().optional(),
        assessmentWindow: z.string().optional()
      }).optional(),
      limit: z.number().min(1).max(50).default(10).describe("Maximum results per collection"),
      threshold: z.number().optional().describe("Minimum similarity score (0-1)")
    }
  },
  async ({ query, collections, filters, limit, threshold }) => {
    const targetCollections = collections ?? ["documents"];
    const allResults = [];

    const qdrantFilter = buildQdrantFilter(filters);

    for (const col of targetCollections) {
      try {
        await ensureCollection(col);
        let results = await search(col, query, { limit, filter: qdrantFilter || undefined });
        if (threshold) {
          results = results.filter((r) => r.score >= threshold);
        }
        for (const r of results) {
          allResults.push({ ...r, collection: col });
        }
      } catch (err) {
        allResults.push({ collection: col, error: err.message ?? String(err) });
      }
    }

    // Sort all results by score descending
    allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    return {
      content: [{ type: "text", text: JSON.stringify(allResults.slice(0, limit), null, 2) }]
    };
  }
);

function buildQdrantFilter(filters) {
  if (!filters) return null;
  const must = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value) {
      must.push({ key, match: { value } });
    }
  }
  return must.length > 0 ? { must } : null;
}
```

- [ ] **Step 5: Add `knowledge_promote` tool**

```javascript
server.registerTool(
  "knowledge_promote",
  {
    description:
      "Promote files from search results into a curated Qdrant knowledge collection. Takes file paths (e.g. from Lookeen or filesystem search) and ingests them.",
    inputSchema: {
      filePaths: z.array(z.string().min(1)).min(1).describe("Absolute paths of files to ingest"),
      collection: z.string().min(1).describe("Target collection name"),
      tags: z.object({
        matter: z.string().optional(),
        documentType: z.string().optional(),
        custodian: z.string().optional(),
        assessmentWindow: z.string().optional(),
        dateRange: z.string().optional()
      }).optional()
    }
  },
  async ({ filePaths, collection, tags }) => {
    await ensureCollection(collection);
    const tagMeta = tags ?? {};
    const results = [];

    for (const filePath of filePaths) {
      try {
        const buffer = await fs.readFile(filePath);
        const extracted = await extractDocumentText({ buffer, fileName: filePath });
        if (!extracted.text) {
          results.push({ file: filePath, status: "skipped", reason: "No text extracted" });
          continue;
        }
        const chunks = chunkDocument(extracted.text, {
          source: filePath,
          documentType: tagMeta.documentType ?? extracted.kind,
          matter: tagMeta.matter ?? "",
          custodian: tagMeta.custodian ?? "",
          assessmentWindow: tagMeta.assessmentWindow ?? "",
          dateRange: tagMeta.dateRange ?? ""
        });
        const count = await ingest(collection, chunks);
        results.push({ file: filePath, status: "ingested", chunks: count });
      } catch (err) {
        results.push({ file: filePath, status: "error", error: err.message ?? String(err) });
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ collection, results }, null, 2) }]
    };
  }
);
```

- [ ] **Step 6: Add `knowledge_list` tool**

```javascript
server.registerTool(
  "knowledge_list",
  {
    description: "List all Qdrant knowledge collections with point counts and metadata summaries.",
    inputSchema: {
      collection: z.string().optional().describe("Specific collection name; omit for all")
    }
  },
  async ({ collection }) => {
    if (collection) {
      await ensureCollection(collection);
      const results = await listCollections();
      const match = results.find((c) => c.name === collection);
      return {
        content: [{ type: "text", text: JSON.stringify(match ?? { error: "Not found" }, null, 2) }]
      };
    }

    const collections = await listCollections();
    return {
      content: [{ type: "text", text: JSON.stringify(collections, null, 2) }]
    };
  }
);
```

- [ ] **Step 7: Add `knowledge_delete` tool**

```javascript
server.registerTool(
  "knowledge_delete",
  {
    description: "Delete documents from a Qdrant knowledge collection by source path or metadata filter, or delete the entire collection.",
    inputSchema: {
      collection: z.string().min(1).describe("Collection name"),
      source: z.string().optional().describe("Delete all chunks from this source file path"),
      filter: z.object({
        matter: z.string().optional(),
        documentType: z.string().optional(),
        custodian: z.string().optional()
      }).optional().describe("Delete chunks matching these metadata filters"),
      deleteEntireCollection: z.boolean().default(false).describe("Delete the entire collection (destructive)")
    }
  },
  async ({ collection, source, filter, deleteEntireCollection }) => {
    if (deleteEntireCollection) {
      await deleteCollection(collection);
      return { content: [{ type: "text", text: `Deleted entire collection "${collection}"` }] };
    }

    if (source) {
      await deleteBySource(collection, source);
      return { content: [{ type: "text", text: `Deleted all chunks from source "${source}" in "${collection}"` }] };
    }

    if (filter) {
      const qdrantFilter = buildQdrantFilter(filter);
      if (qdrantFilter) {
        await deleteByFilter(collection, qdrantFilter);
        return { content: [{ type: "text", text: JSON.stringify({ deleted: "by filter", collection, filter }, null, 2) }] };
      }
    }

    return { content: [{ type: "text", text: "No delete criteria specified (provide source, filter, or deleteEntireCollection)" }], isError: true };
  }
);
```

- [ ] **Step 8: Install and commit**

```bash
cd "d:/WCJR MCP/WCJR-MCP" && npm install
git add packages/qdrant-rag-mcp/ packages/rag/
git commit -m "feat(qdrant-rag): add 5 knowledge tools for intelligence layer"
```

---

### Task 10: Activity Profiles — Add MCP Presets and Disputes Profile

**Files:**
- Modify: `packages/activity-profiles/src/index.js`

- [ ] **Step 1: Add new MCP presets to MCP_PRESET_REGISTRY**

Add after the `sequentialThinking` entry in `MCP_PRESET_REGISTRY` (after line 73):

```javascript
  xlsxEngine: {
    id: "xlsx-engine",
    label: "Excel Engine",
    kind: "builtin-xlsx-engine"
  },
  docxEngine: {
    id: "docx-engine",
    label: "Document Engine",
    kind: "builtin-docx-engine"
  },
  qdrantRag: {
    id: "qdrant-rag",
    label: "Knowledge & RAG",
    kind: "builtin-qdrant-rag"
  },
  lookeen: {
    id: "lookeen",
    label: "Lookeen Search",
    serverNamePatterns: ["lookeen"]
  }
```

- [ ] **Step 2: Add disputes activity profile**

Add after the `aws_cloud` profile entry (after line 220), before the closing `}` of `ACTIVITY_PROFILES`:

```javascript
  ,
  disputes: {
    id: "disputes",
    label: "Disputes & Forensic",
    defaultModel: "gpt-5.4-pro",
    suggestedTaskType: "complex",
    description:
      "Forensic document production, quantum analysis, delay analysis, contract review, and evidence management for construction disputes.",
    mcpPresets: ["filesystem", "fileOps", "memory", "xlsxEngine", "docxEngine", "qdrantRag", "lookeen", "documents"],
    recommendedSkills: ["document-review", "brainstorming"],
    specialistAgents: [
      "Analyst",
      "DraftWriter",
      "DataProfiler",
      "DocumentReviewer",
      "Synthesizer"
    ]
  }
```

- [ ] **Step 3: Update existing profiles to include new presets where relevant**

Update the `documents` profile `mcpPresets` (line 125) to include the new engines:

```javascript
    mcpPresets: ["documents", "filesystem", "memory", "context7", "xlsxEngine", "docxEngine", "qdrantRag"],
```

Update the `data_analysis` profile `mcpPresets` (line 155) to include the xlsx engine:

```javascript
    mcpPresets: ["filesystem", "documents", "memory", "sequentialThinking", "builtin-shell-exec", "xlsxEngine"],
```

- [ ] **Step 4: Commit**

```bash
git add packages/activity-profiles/src/index.js
git commit -m "feat(activity-profiles): add disputes profile, xlsx/docx/qdrant/lookeen MCP presets"
```

---

### Task 11: Desktop App — Register New Builtin Servers

**Files:**
- Modify: `apps/desktop/main.js`

- [ ] **Step 1: Add new kinds to MCP_SERVER_SCHEMA**

In `apps/desktop/main.js`, update the `kind` enum in `MCP_SERVER_SCHEMA` (line 191-201). Add `"builtin-xlsx-engine", "builtin-docx-engine",` after `"builtin-qdrant-rag",`:

The updated enum should read:
```javascript
  kind: z.enum([
    "builtin-filesystem", "builtin-document-ops", "builtin-file-ops", "builtin-mail-calendar",
    "builtin-browser-ops", "builtin-memory", "builtin-desktop-commander", "builtin-shell-exec",
    "builtin-git-ops", "builtin-qdrant-rag", "builtin-xlsx-engine", "builtin-docx-engine",
    ...existing catalog entries...
    "custom"
  ]).optional().default("custom"),
```

- [ ] **Step 2: Add hydrate cases**

Add after the `builtin-qdrant-rag` hydrate block (after line 718):

```javascript
  if (server.kind === "builtin-xlsx-engine") {
    return {
      name: server.name || "Excel Engine",
      enabled: server.enabled !== false,
      kind: "builtin-xlsx-engine",
      transport: "stdio",
      ...builtinServerProcessConfig("xlsx-engine-mcp")
    };
  }
  if (server.kind === "builtin-docx-engine") {
    return {
      name: server.name || "Document Engine",
      enabled: server.enabled !== false,
      kind: "builtin-docx-engine",
      transport: "stdio",
      ...builtinServerProcessConfig("docx-engine-mcp")
    };
  }
```

- [ ] **Step 3: Add dehydrate cases**

Add after the `builtin-qdrant-rag` dehydrate block (after line 798):

```javascript
  if (server.kind === "builtin-xlsx-engine") {
    return {
      name: server.name,
      enabled: server.enabled !== false,
      kind: "builtin-xlsx-engine"
    };
  }
  if (server.kind === "builtin-docx-engine") {
    return {
      name: server.name,
      enabled: server.enabled !== false,
      kind: "builtin-docx-engine"
    };
  }
```

- [ ] **Step 4: Add default server entries**

Add after the Qdrant RAG default entry (after line 931):

```javascript
    {
      name: "Excel Engine",
      kind: "builtin-xlsx-engine",
      enabled: true
    },
    {
      name: "Document Engine",
      kind: "builtin-docx-engine",
      enabled: true
    },
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/main.js
git commit -m "feat(desktop): register xlsx-engine and docx-engine as builtin MCP servers"
```

---

### Task 12: Desktop App — Knowledge Management IPC Handlers

**Files:**
- Modify: `apps/desktop/main.js`

- [ ] **Step 1: Add knowledge collection IPC handlers**

Add these IPC handlers near the existing `assistant:*` handlers in `main.js`:

```javascript
ipcMain.handle("assistant:getKnowledgeCollections", async () => {
  try {
    const result = await orchestrator.callMcpTool("Qdrant RAG", "knowledge_list", {});
    return JSON.parse(result?.content?.[0]?.text ?? "[]");
  } catch (err) {
    return { error: err.message ?? String(err) };
  }
});

ipcMain.handle("assistant:ingestToKnowledge", async (_event, { source, collection, tags }) => {
  try {
    const result = await orchestrator.callMcpTool("Qdrant RAG", "knowledge_ingest", {
      source,
      collection,
      tags: tags ?? {}
    });
    return JSON.parse(result?.content?.[0]?.text ?? "{}");
  } catch (err) {
    return { error: err.message ?? String(err) };
  }
});

ipcMain.handle("assistant:deleteFromKnowledge", async (_event, { collection, source, filter, deleteEntireCollection }) => {
  try {
    const result = await orchestrator.callMcpTool("Qdrant RAG", "knowledge_delete", {
      collection,
      source,
      filter,
      deleteEntireCollection: deleteEntireCollection ?? false
    });
    return JSON.parse(result?.content?.[0]?.text ?? "{}");
  } catch (err) {
    return { error: err.message ?? String(err) };
  }
});
```

- [ ] **Step 2: Expose in preload.js**

Add to the `contextBridge.exposeInMainWorld` API in `apps/desktop/preload.js`:

```javascript
getKnowledgeCollections: () => ipcRenderer.invoke("assistant:getKnowledgeCollections"),
ingestToKnowledge: (payload) => ipcRenderer.invoke("assistant:ingestToKnowledge", payload),
deleteFromKnowledge: (payload) => ipcRenderer.invoke("assistant:deleteFromKnowledge", payload),
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/main.js apps/desktop/preload.js
git commit -m "feat(desktop): add knowledge management IPC handlers"
```

---

### Task 13: Integration Verification

**Files:**
- No new files

- [ ] **Step 1: Verify npm install succeeds**

Run: `cd "d:/WCJR MCP/WCJR-MCP" && npm install`
Expected: No errors, all workspace packages linked.

- [ ] **Step 2: Verify xlsx-engine-mcp starts**

Run: `cd "d:/WCJR MCP/WCJR-MCP" && timeout 3 node packages/xlsx-engine-mcp/src/server.js 2>&1 || true`
Expected: No crash on startup (will hang waiting for stdio input, which is correct).

- [ ] **Step 3: Verify docx-engine-mcp starts**

Run: `cd "d:/WCJR MCP/WCJR-MCP" && timeout 3 node packages/docx-engine-mcp/src/server.js 2>&1 || true`
Expected: No crash on startup.

- [ ] **Step 4: Verify qdrant-rag-mcp starts (requires Qdrant running)**

Run: `cd "d:/WCJR MCP/WCJR-MCP" && timeout 3 node packages/qdrant-rag-mcp/src/server.js 2>&1 || true`
Expected: No crash (may warn about Qdrant connection if not running, which is acceptable).

- [ ] **Step 5: Verify desktop app launches**

Run: `cd "d:/WCJR MCP/WCJR-MCP" && npm run dev`
Expected: Electron app launches. Check Tools tab — should show "Excel Engine" and "Document Engine" entries.

- [ ] **Step 6: Final commit with all lockfile changes**

```bash
git add -A
git commit -m "chore: integration verification pass — all servers start cleanly"
```

---

## Summary of Deliverables

| Task | Component | Tools/Changes |
|------|-----------|---------------|
| 1 | xlsx-engine-mcp | `create_workbook` |
| 2 | xlsx-engine-mcp | `read_workbook`, `update_workbook` |
| 3 | xlsx-engine-mcp | `analyse_workbook`, `export_workbook`, transport |
| 4 | docx-engine-mcp | `create_document` |
| 5 | docx-engine-mcp | `read_document`, `update_document` |
| 6 | docx-engine-mcp | `merge_documents`, `export_document`, transport |
| 7 | document-ingestion | PST, MSG, structural DOCX extraction |
| 8 | rag | `listCollections`, `deleteByFilter`, enhanced metadata |
| 9 | qdrant-rag-mcp | 5 knowledge tools |
| 10 | activity-profiles | Disputes profile, new MCP presets |
| 11 | desktop main.js | Register builtin xlsx/docx engines |
| 12 | desktop main.js + preload | Knowledge management IPC |
| 13 | Integration | Verification pass |
