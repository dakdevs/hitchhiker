import { PluginApiError, type PluginApi, type ObservedPage } from "@hitchhiker/plugin-sdk";

/** Notifications invalidate the snapshot; never combine chunks from different revisions. */
export const readPages = async (api: {
  readonly pages: Pick<PluginApi["pages"], "watch">;
}): Promise<{ revision: number; pages: readonly ObservedPage[] }> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const first = await api.pages.watch();
      const pages = [...first.pages];
      let offset = first.nextOffset;
      while (offset !== undefined) {
        if (pages.length > 128) throw new Error("Default tab page limit exceeded");
        const next = await api.pages.watch({ offset, revision: first.revision });
        if (
          next.revision !== first.revision ||
          (next.nextOffset !== undefined && next.nextOffset <= offset)
        )
          throw new Error("Invalid page continuation");
        pages.push(...next.pages);
        offset = next.nextOffset;
      }
      if (pages.length > 128) throw new Error("Default tab page limit exceeded");
      return { revision: first.revision, pages };
    } catch (error) {
      if (!(error instanceof PluginApiError) || error.code !== "stale-snapshot" || attempt === 2)
        throw error;
    }
  }
  throw new Error("Page snapshot unavailable");
};

/** Every command and invalidation joins the same queue; a failure does not poison later requests. */
export const serial = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return <A>(work: () => Promise<A>): Promise<A> => {
    const result = tail.then(work);
    tail = result.catch(() => undefined);
    return result;
  };
};
