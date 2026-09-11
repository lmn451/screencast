/** Find recorder pages using extension-owned contexts, without tabs permission. */
export async function findRecorderContextTabIds(recordingId: string): Promise<number[]> {
  const expected = new URL(chrome.runtime.getURL('recorder.html'));
  const matches = (url: string | undefined): boolean => {
    if (!url) return false;
    try {
      const candidate = new URL(url);
      return (
        candidate.protocol === expected.protocol &&
        candidate.host === expected.host &&
        candidate.pathname === expected.pathname &&
        candidate.searchParams.get('id') === recordingId
      );
    } catch {
      return false;
    }
  };

  if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['TAB' as chrome.runtime.ContextType],
    });
    return contexts
      .filter((context) => matches(context.documentUrl) && context.tabId >= 0)
      .map((context) => context.tabId);
  }

  // Firefox background pages expose the extension's own windows. Looking at
  // these windows cannot disclose ordinary browsing tabs and still detects a
  // recorder tab that navigated away while the background was unavailable.
  if (typeof chrome.extension?.getViews === 'function') {
    const views = chrome.extension
      .getViews({ type: 'tab' })
      .filter((view) => matches(view.location.href));
    const tabs = await Promise.all(
      views.map(
        (view) =>
          new Promise<chrome.tabs.Tab | undefined>((resolve, reject) => {
            const pageChrome = (view as Window & { chrome: typeof chrome }).chrome;
            pageChrome.tabs.getCurrent((tab) => {
              const error = pageChrome.runtime.lastError;
              if (error) reject(new Error(error.message));
              else resolve(tab);
            });
          })
      )
    );
    return tabs.flatMap((tab) => (tab?.id == null ? [] : [tab.id]));
  }
  throw new Error('Recorder context discovery is unavailable');
}
