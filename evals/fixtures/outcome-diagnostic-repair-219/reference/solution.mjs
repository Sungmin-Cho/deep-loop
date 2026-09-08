export function clampWindow(v,min,max){return [v,min,max].every(Number.isFinite)?Math.min(Math.max(min,max),Math.max(Math.min(min,max),v)):null;}
