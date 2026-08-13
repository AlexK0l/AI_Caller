import ExcelJS from 'exceljs';

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();
}

function normalizePhone(value) {
  if (value == null) return '';
  let raw = String(value).trim();
  if (!raw) return '';
  raw = raw.replace(/[\s()\-]/g, '');
  if (raw.startsWith('00')) raw = `+${raw.slice(2)}`;
  if (!raw.startsWith('+') && /^\d+$/.test(raw)) raw = `+${raw}`;
  return raw;
}

function parseBoolean(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value || '').trim().toLowerCase();
  return ['да', 'yes', 'true', '1', '+', 'согласен', 'согласие получено'].includes(normalized);
}

const aliases = {
  phone: ['телефон', 'номер телефона', 'phone', 'номер'],
  name: ['имя', 'фио', 'клиент', 'name'],
  purpose: ['цель', 'цель звонка', 'purpose'],
  consent: ['согласие', 'consent', 'разрешение на звонок'],
  consentSource: ['источник согласия', 'основание согласия', 'consent source'],
  product: ['продукт', 'интерес', 'модель', 'product'],
  company: ['компания клиента', 'организация', 'company'],
  comment: ['комментарий', 'примечание', 'comment'],
};

function findColumn(headerMap, key) {
  for (const alias of aliases[key] || []) {
    if (headerMap.has(alias)) return headerMap.get(alias);
  }
  return null;
}

export async function parseClientsExcel(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('В Excel нет листов');

  const headerMap = new Map();
  sheet.getRow(1).eachCell((cell, colNumber) => {
    headerMap.set(normalizeHeader(cell.text || cell.value), colNumber);
  });

  const phoneCol = findColumn(headerMap, 'phone');
  const nameCol = findColumn(headerMap, 'name');
  if (!phoneCol || !nameCol) {
    throw new Error('В первой строке должны быть колонки «Телефон» и «Имя»');
  }

  const columns = Object.fromEntries(
    Object.keys(aliases).map((key) => [key, findColumn(headerMap, key)]),
  );

  const clients = [];
  const rejected = [];

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (!row.hasValues) continue;

    const get = (key) => {
      const col = columns[key];
      return col ? row.getCell(col).text || row.getCell(col).value || '' : '';
    };

    const phone = normalizePhone(get('phone'));
    const name = String(get('name') || '').trim();
    const consent = parseBoolean(get('consent'));
    const consentSource = String(get('consentSource') || '').trim();

    const reasons = [];
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) reasons.push('Некорректный телефон E.164');
    if (!name) reasons.push('Не указано имя');
    if (!consent) reasons.push('Нет подтверждённого согласия на звонок');
    if (!consentSource) reasons.push('Не указан источник согласия');

    if (reasons.length) {
      rejected.push({ row: rowNumber, phone, name, reasons });
      continue;
    }

    const product = String(get('product') || '').trim();
    const company = String(get('company') || '').trim();
    const comment = String(get('comment') || '').trim();
    const purpose =
      String(get('purpose') || '').trim() ||
      (product
        ? `Рассказать о продукции САТ с учётом интереса клиента к «${product}», ответить на вопросы и определить следующий шаг.`
        : 'Рассказать о продукции САТ, выяснить потребность клиента, ответить на вопросы и определить следующий шаг.');

    clients.push({
      to: phone,
      name,
      purpose,
      consent: true,
      consentSource,
      metadata: {
        product: product || null,
        company: company || null,
        comment: comment || null,
        excelRow: rowNumber,
      },
    });
  }

  return {
    sheetName: sheet.name,
    totalRows: Math.max(0, sheet.rowCount - 1),
    clients,
    rejected,
  };
}
