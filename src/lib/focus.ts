/* Focus helpers. When the element that had focus disappears (a view swaps, a row is deleted, a
   dialog's trigger unmounts) the browser drops focus on <body> and keyboard / screen-reader users
   start again from the skip link. These put it back somewhere meaningful. */

/** Move focus to the page heading inside <main> (or <main> itself). Returns true when focus moved. */
export function focusMainHeading(): boolean {
  const target = document.querySelector<HTMLElement>('#main h1') ?? document.getElementById('main');
  if (!target) return false;
  if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}

/** True when focus is nowhere useful: nothing, <body>, or an element that has left the document. */
export function focusIsLost(): boolean {
  const el = document.activeElement;
  return !el || el === document.body || !el.isConnected;
}
