// A tiny history stand-in. linkedom has no window.history the route hook can use.

export function installOnboardHistory() {
  const entries = [{ hash: '', state: null }]
  let index = 0
  const location = {
    pathname: '/',
    search: '',
    hash: '',
    assign: () => {},
  }
  function hashFrom(url) {
    const value = String(url)
    return value.includes('#') ? value.slice(value.indexOf('#')) : ''
  }
  function show() {
    location.hash = entries[index].hash
  }
  const history = {
    get state() { return entries[index].state },
    pushState(state, _title, url) {
      entries.splice(index + 1)
      entries.push({ hash: hashFrom(url), state })
      index = entries.length - 1
      show()
    },
    replaceState(state, _title, url) {
      entries[index] = { hash: hashFrom(url), state }
      show()
    },
    back() {
      if (index > 0) index -= 1
      show()
      window.dispatchEvent(new window.Event('popstate'))
    },
    forward() {
      if (index < entries.length - 1) index += 1
      show()
      window.dispatchEvent(new window.Event('popstate'))
    },
  }
  window.location = location
  window.history = history
  return history
}
