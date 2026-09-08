export function parseRow(r){const quantity=Number(r.quantity),price=Number(r.price);return Number.isFinite(quantity)&&Number.isFinite(price)&&quantity>=0&&price>=0?{quantity,price}:null;}
