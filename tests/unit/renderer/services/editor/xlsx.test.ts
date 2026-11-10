import { describe, expect, it } from "bun:test";
import { strToU8, zipSync } from "fflate";
import {
  cellPosition,
  columnName,
} from "../../../../../src/renderer/services/editor/preview/spreadsheet";
import {
  readWorkbook,
  resolvePart,
  SpreadsheetError,
} from "../../../../../src/renderer/services/editor/preview/xlsx";

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A workbook file from its sheets' XML, with what else a workbook has. */
function workbook({
  sheets,
  strings = [],
  styles = "",
  workbookPr = "",
}: {
  sheets: { name: string; xml?: string; state?: string; chart?: boolean }[];
  strings?: string[];
  styles?: string;
  workbookPr?: string;
}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "_rels/.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0"?><workbook ${NS} ${R_NS}>${workbookPr}<sheets>${sheets
        .map(
          (s, i) =>
            `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ""} r:id="rIdS${i}"/>`,
        )
        .join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((s, i) =>
          s.chart
            ? `<Relationship Id="rIdS${i}" Type="${REL}/chartsheet" Target="chartsheets/sheet${i}.xml"/>`
            : `<Relationship Id="rIdS${i}" Type="${REL}/worksheet" Target="/xl/worksheets/sheet${i}.xml"/>`,
        )
        .join(
          "",
        )}<Relationship Id="rIdSS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdST" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/sharedStrings.xml": strToU8(
      `<sst ${NS} count="${strings.length}">${strings.map((s) => `<si>${s}</si>`).join("")}</sst>`,
    ),
    "xl/styles.xml": strToU8(`<styleSheet ${NS}>${styles}</styleSheet>`),
  };
  sheets.forEach((s, i) => {
    if (s.xml !== undefined && !s.chart) {
      files[`xl/worksheets/sheet${i}.xml`] = strToU8(`<worksheet ${NS}>${s.xml}</worksheet>`);
    }
  });
  return zipSync(files);
}

const texts = (rows: readonly (readonly ({ text: string } | undefined)[] | undefined)[]) =>
  Array.from(rows, (row) => (row ? Array.from(row, (cell) => cell?.text ?? "") : null));

describe("readWorkbook", () => {
  it("reads each kind of cell value where the file puts it", () => {
    const { sheets } = readWorkbook(
      workbook({
        strings: [
          "<t>Name</t>",
          '<r><t>Rich </t></r><r><rPr><b/></rPr><t xml:space="preserve">text</t></r>',
          '<t>漢字</t><rPh sb="0" eb="2"><t>かんじ</t></rPh>',
          "<t>a &amp; b_x000D_</t>",
        ],
        sheets: [
          {
            name: "Data",
            xml: `<sheetData>
              <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
              <row r="2"><c r="A2"><v>42</v></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="e"><f>1/0</f><v>#DIV/0!</v></c></row>
              <row r="4"><c r="B4" t="str"><f>A1&amp;"!"</f><v>Name!</v></c><c r="C4" t="inlineStr"><is><t>inline</t></is></c></row>
              <row r="5"><c r="A5" t="s"><v>2</v></c><c r="B5" t="s"><v>3</v></c><c r="C5"><f>A2*2</f></c><c r="D5" s="1"/></row>
            </sheetData>`,
          },
        ],
      }),
    );
    expect(sheets).toHaveLength(1);
    const [sheet] = sheets;
    expect(sheet?.name).toBe("Data");
    expect(sheet?.columns).toBe(3);
    expect(texts(sheet?.rows ?? [])).toEqual([
      ["Name", "", "Rich text"],
      ["42", "TRUE", "#DIV/0!"],
      null,
      ["", "Name!", "inline"],
      ["漢字", "a & b\r"],
    ]);
    expect(sheet?.rows[1]?.[0]).toEqual({ text: "42", numeric: true });
    expect(sheet?.rows[1]?.[1]?.numeric).toBe(false);
  });

  it("writes numbers and dates out in their cell's number format", () => {
    const styles = `<numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts>
      <cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="10"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="3"/></cellXfs>`;
    const xml = `<sheetData><row r="1">
      <c r="A1"><v>0.30000000000000004</v></c><c r="B1" s="1"><v>0.1234</v></c><c r="C1" s="2"><v>1234.5</v></c>
      <c r="D1" s="3"><v>45000</v></c><c r="E1" s="4"><v>1234567</v></c><c r="F1" s="9"><v>7</v></c>
    </row></sheetData>`;
    const [sheet] = readWorkbook(workbook({ styles, sheets: [{ name: "S", xml }] })).sheets;
    expect(texts(sheet?.rows ?? [])).toEqual([
      ["0.3", "12.34%", "$1,234.50", "2023-03-15", "1,234,567", "7"],
    ]);

    const [sheet1904] = readWorkbook(
      workbook({ styles, workbookPr: '<workbookPr date1904="1"/>', sheets: [{ name: "S", xml }] }),
    ).sheets;
    expect(sheet1904?.rows[0]?.[3]?.text).toBe("2027-03-16");
  });

  it("gives the visible sheets in workbook order, a chart sheet with no cells", () => {
    const one = '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>';
    const { sheets } = readWorkbook(
      workbook({
        sheets: [
          { name: "Second", xml: one },
          { name: "Secret", xml: one, state: "hidden" },
          { name: "Chart", chart: true },
          { name: "Blank", xml: "<sheetData/>" },
        ],
      }),
    );
    expect(sheets.map((s) => [s.name, s.chart, s.columns])).toEqual([
      ["Second", false, 1],
      ["Chart", true, 0],
      ["Blank", false, 0],
    ]);
  });

  it("places cells without a reference after the one before", () => {
    const [sheet] = readWorkbook(
      workbook({
        sheets: [
          {
            name: "S",
            xml: '<sheetData><row><c><v>1</v></c><c><v>2</v></c></row><row><c r="C2"><v>3</v></c><c><v>4</v></c></row></sheetData>',
          },
        ],
      }),
    ).sheets;
    expect(texts(sheet?.rows ?? [])).toEqual([
      ["1", "2"],
      ["", "", "3", "4"],
    ]);
  });

  it("refuses bytes that are not a workbook", () => {
    expect(() => readWorkbook(strToU8("not a zip"))).toThrow(SpreadsheetError);
    expect(() => readWorkbook(zipSync({ "a.xml": strToU8("<a/>") }))).toThrow(SpreadsheetError);
  });
});

describe("cell references", () => {
  it("reads A1 references, absolute ones too", () => {
    expect(cellPosition("A1")).toEqual({ row: 0, column: 0 });
    expect(cellPosition("$AB$12")).toEqual({ row: 11, column: 27 });
    expect(cellPosition("XFD1048576")).toEqual({ row: 1048575, column: 16383 });
    expect(cellPosition("R1C1")).toBeNull();
  });

  it("names columns as the spreadsheet does", () => {
    expect([0, 25, 26, 27, 701, 702, 16383].map(columnName)).toEqual([
      "A",
      "Z",
      "AA",
      "AB",
      "ZZ",
      "AAA",
      "XFD",
    ]);
  });
});

describe("resolvePart", () => {
  it("resolves a relationship's target against the part it is read from", () => {
    expect(resolvePart("xl/workbook.xml", "worksheets/sheet1.xml")).toBe(
      "xl/worksheets/sheet1.xml",
    );
    expect(resolvePart("xl/workbook.xml", "/xl/styles.xml")).toBe("xl/styles.xml");
    expect(resolvePart("xl/worksheets/sheet1.xml", "../drawings/d1.xml")).toBe(
      "xl/drawings/d1.xml",
    );
    expect(resolvePart("", "xl/workbook.xml")).toBe("xl/workbook.xml");
  });
});
