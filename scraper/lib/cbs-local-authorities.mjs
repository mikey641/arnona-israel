import { strFromU8, unzipSync } from "fflate";

export const CBS_LOCAL_AUTHORITIES_URL = "https://www.cbs.gov.il/he/publications/LochutTlushim/2024/"
  + "%D7%9E%D7%99%D7%9C%D7%95%D7%9F%20%D7%A8%D7%A9%D7%95%D7%AA%20%D7%9E%D7%A7%D7%95%D7%9E%D7%99%D7%AA%20"
  + "%2B%20%D7%9E%D7%98%D7%90%20%D7%93%D7%90%D7%98%D7%94.xlsx";

const AUTHORITY_TYPES = {
  1: { key: "municipality", prefix: "עיריית" },
  2: { key: "local_council", prefix: "מועצה מקומית" },
  3: { key: "regional_council", prefix: "מועצה אזורית" },
};

function xmlText(value = "") {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function workbookXml(files, path) {
  const bytes = files[path];
  if (!bytes) throw new Error(`CBS workbook is missing ${path}`);
  return strFromU8(bytes);
}

function sharedStrings(xml) {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((text) => xmlText(text[1]))
      .join(""));
}

function worksheetRows(xml, strings) {
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((match) => {
    const row = {};
    for (const cell of match[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const column = cell[1].match(/\br="([A-Z]+)/)?.[1];
      if (!column) continue;
      const raw = cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
      row[column] = /\bt="s"/.test(cell[1]) ? strings[Number(raw)] ?? "" : xmlText(raw);
    }
    return row;
  });
}

export function parseCbsLocalAuthoritiesXlsx(buffer) {
  let files;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch (error) {
    throw new Error(`CBS local-authority workbook is not a valid XLSX: ${error?.message ?? error}`);
  }
  const strings = sharedStrings(workbookXml(files, "xl/sharedStrings.xml"));
  const rows = worksheetRows(workbookXml(files, "xl/worksheets/sheet1.xml"), strings);
  const header = rows[0] ?? {};
  if (header.B !== "SemelRashut" || header.C !== "ShemRashut" || header.E !== "SemelSugMaamad") {
    throw new Error("CBS local-authority workbook columns changed");
  }

  const authorities = rows.slice(1).map((row) => {
    const code = String(row.B ?? "").trim();
    const name = String(row.C ?? "").trim();
    const sourceYear = Number(row.A);
    const statusCode = Number(row.E);
    const type = AUTHORITY_TYPES[statusCode];
    if (!code || !name || !Number.isInteger(sourceYear) || !type) return null;
    return {
      code,
      name,
      englishName: String(row.D ?? "").trim() || null,
      sourceYear,
      statusCode,
      authorityType: type.key,
      municipalName: `${type.prefix} ${name}`,
    };
  }).filter(Boolean);

  const uniqueCodes = new Set(authorities.map((authority) => authority.code));
  if (authorities.length < 200 || authorities.length > 400 || uniqueCodes.size !== authorities.length) {
    throw new Error(`CBS local-authority workbook returned an implausible ${authorities.length} rows`);
  }
  return authorities;
}

export function cbsAuthorityCityKey(code) {
  return `cbs-${String(code).padStart(4, "0")}`;
}
