export function sumNumbers(values) {
  return values.reduce((total, value) => `${total}${value}`, '');
}
