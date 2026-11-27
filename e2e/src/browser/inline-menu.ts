import { BrowserContext, Page, expect } from "@playwright/test";

type DomNode = {
  nodeId: number;
  nodeName: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
};

function unlockButton(node: DomNode): DomNode | undefined {
  const attributes = node.attributes ?? [];
  if (
    node.nodeName === "BUTTON" &&
    (attributes.includes("unlock-button") || attributes.includes("inline-menu-unlock-button"))
  ) {
    return node;
  }
  const descendants = [...(node.children ?? []), ...(node.shadowRoots ?? [])];
  if (node.contentDocument) {
    descendants.push(node.contentDocument);
  }
  for (const child of descendants) {
    const found = unlockButton(child);
    if (found) {
      return found;
    }
  }
}

/** Clicks the real inline Unlock button, including its closed shadow root. No test-only opener. */
export async function clickInlineUnlock(context: BrowserContext, page: Page): Promise<void> {
  await expect
    .poll(() => page.frames().some((frame) => /\/overlay\/menu-list\.html/.test(frame.url())))
    .toBe(true);
  const frame = page
    .frames()
    .find((candidate) => /\/overlay\/menu-list\.html/.test(candidate.url()))!;
  const cdp = await context.newCDPSession(frame).catch(() => context.newCDPSession(page));
  try {
    await cdp.send("DOM.enable");
    let button: DomNode | undefined;
    await expect
      .poll(async () => {
        const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
        button = unlockButton(root);
        return !!button;
      })
      .toBe(true);
    const { model } = await cdp.send("DOM.getBoxModel", { nodeId: button!.nodeId });
    const quad = model.content;
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  } finally {
    await cdp.detach();
  }
}
