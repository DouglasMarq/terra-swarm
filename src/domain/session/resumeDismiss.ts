export type ResumeDismissResult<Item> =
  | { item: Item; status: "succeeded" }
  | { item: Item; status: "failed"; error: unknown };

export async function dismissResumeItems<Item>(
  items: readonly Item[],
  kill: (item: Item) => Promise<void>,
): Promise<ResumeDismissResult<Item>[]> {
  return Promise.all(
    items.map(async (item): Promise<ResumeDismissResult<Item>> => {
      try {
        await kill(item);
        return { item, status: "succeeded" };
      } catch (error) {
        return { item, status: "failed", error };
      }
    }),
  );
}
