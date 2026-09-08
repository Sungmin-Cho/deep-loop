import { parseRow } from './parse.mjs';
import { lineCents } from './money.mjs';
export function totalInvoice(rows){ return rows.map(parseRow).reduce((s,r)=>s+lineCents(r),0); }
