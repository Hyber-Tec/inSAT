// A variant (lib/variation) is its source question with new numbers, so a
// question and its variants form one lineage, named by the source's id.
export const lineageOf = (row) => row.variant_of || row.id;
