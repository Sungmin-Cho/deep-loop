import { parseRow } from './parse.mjs';
import { lineCents } from './money.mjs';
export function totalInvoice(rows){return rows.map(parseRow).filter(Boolean).reduce((n,r)=>n+lineCents(r),0)/100;}
