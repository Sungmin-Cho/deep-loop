export function latestById(records){return [...new Map(records.map(r=>[r.id,r])).values()];}
