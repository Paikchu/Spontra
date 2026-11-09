import { thumbBox } from "./desktop-model";

const VISIBLE_MS = 800;

/** Native scrollbars are hidden everywhere; a thumb is drawn over whatever is scrolling and fades when it stops. */
export function showScrollThumbs() {
  const thumb = document.createElement("div");
  thumb.className = "desktop-scroll-thumb";
  thumb.setAttribute("aria-hidden", "true");
  let timer: ReturnType<typeof setTimeout> | undefined;
  addEventListener("scroll", event => {
    const element = event.target instanceof Element ? event.target : document.documentElement;
    const box = element.getBoundingClientRect();
    const placed = thumbBox({ top: box.top, right: box.right, height: element.clientHeight }, element.scrollTop, element.scrollHeight);
    if (!placed) return;
    // A modal dialog sits in the top layer; the thumb has to be inside it to be seen.
    const parent = (element.closest("dialog") ?? document.body) as HTMLElement;
    if (thumb.parentElement !== parent) parent.appendChild(thumb);
    thumb.style.cssText = `top:${placed.top}px;left:${placed.left}px;height:${placed.height}px`;
    thumb.dataset.visible = "";
    clearTimeout(timer);
    timer = setTimeout(() => { delete thumb.dataset.visible; }, VISIBLE_MS);
  }, { capture: true, passive: true });
}
