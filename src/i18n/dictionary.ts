export interface PluralLeaf {
  zero?: string;
  one: string;
  other: string;
}

export type Dictionary<T> = {
  [K in keyof T]: T[K] extends string ? string : T[K] extends PluralLeaf ? PluralLeaf : Dictionary<T[K]>;
};
