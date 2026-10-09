// test-utils/dom.js — a minimal DOM for interactive component tests, on linkedom (already a
// dependency) instead of a new jsdom/testing-library dependency. Real React (createRoot +
// act); events are dispatched on real nodes and bubble to React's root listener.

import { parseHTML } from 'linkedom'
import { act } from 'react'

export async function mountDom() {
  const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true })
  for (const k of ['Node', 'Element', 'HTMLElement', 'Event', 'KeyboardEvent']) {
    if (window[k] && !(k in globalThis)) globalThis[k] = window[k]
  }
  // React picks its onChange strategy at load time from `'oninput' in document`; linkedom's
  // document lacks the property, so declare it before react-dom loads.
  if (!('oninput' in document)) document.oninput = null
  const { createRoot } = await import('react-dom/client')
  const container = document.getElementById('root')
  const root = createRoot(container)
  const q = (sel) => container.querySelector(sel)
  const buttons = () => [...container.querySelectorAll('button')]
  const button = (text) => buttons().find((b) => b.textContent.includes(text))
  return {
    container,
    q,
    buttons,
    button,
    text: () => container.textContent,
    render: (el) => act(async () => { root.render(el) }),
    unmount: () => act(async () => { root.unmount() }),
    click: (node) => act(async () => { node.dispatchEvent(new window.Event('click', { bubbles: true })) }),
    keydown: (node, key) => act(async () => {
      const e = new window.Event('keydown', { bubbles: true, cancelable: true })
      e.key = key
      node.dispatchEvent(e)
    }),
    // Type into a controlled field: the prototype setter bypasses React's value tracker.
    type: (node, value) => act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value')?.set
      setter.call(node, value)
      node.dispatchEvent(new window.Event('input', { bubbles: true }))
    }),
    submit: (form) => act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })) }),
    // Settle a promise the component is awaiting, inside act so its state update flushes.
    settle: (fn) => act(async () => { await fn() }),
  }
}

// A promise whose resolution the test controls.
export function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
