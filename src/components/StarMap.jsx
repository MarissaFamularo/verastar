// components/StarMap.jsx — the knowledge graph rendered as a living star map.
//
// A self-contained canvas: deep-space background, a tiny force simulation that lays the
// stars out, and the money shot — when a suggested (dashed, pulsing) connection is
// confirmed, the constellation line CHARTS ITSELF: it draws end-to-end, both stars flare,
// and a particle runs the path. No graph library; for <60 nodes an O(n²) sim is smooth and
// gives us pixel-level control over the reveal. React just mounts the canvas and hands in
// { nodes, edges } + callbacks; a persistent engine in refs owns positions, camera, and
// animation so it survives re-renders without relayout.

import { useEffect, useRef } from 'react'
import { domainColor, PROJECT_COLOR, NORTHSTAR_COLOR, DEFAULT_PAPER_COLOR } from '../lib/domains.js'

// --- star colors: north stars are the radiant gold steering anchors; projects echo her
// "Projects" yellow; paper stars take the color of the clinician's own domain taxonomy. ---
function starColor(node) {
  if (node.kind === 'northStar') return { core: '#fff4cf', glow: NORTHSTAR_COLOR }
  if (node.kind === 'project') return { core: '#fff2c2', glow: PROJECT_COLOR }
  const c = node.domain ? domainColor(node.domain) : DEFAULT_PAPER_COLOR
  return { core: c, glow: c }
}
const EDGE_CONFIRMED = '150,180,255'
const EDGE_SUGGEST = '190,205,255'
const INVITE = '255,214,120' // the gold "click me" twinkle on a suggested link

const RADIUS = { northStar: 9, project: 6.5, concept: 6, paper: 4.5 }
const REVEAL_MS = 950

// Stable pseudo-random in [0,1) from a string — per-node twinkle phase + seed jitter,
// without Math.random (so a node doesn't re-seed differently on every mount).
function hash01(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

export default function StarMap({
  nodes,
  edges,
  selectedId = null,
  onSelectNode,
  onConfirmEdge,
  onBackground,
}) {
  const canvasRef = useRef(null)
  const engineRef = useRef(null)

  // Mirror the latest props into refs so the rAF loop always reads fresh data.
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const selectedRef = useRef(selectedId)
  nodesRef.current = nodes
  edgesRef.current = edges
  selectedRef.current = selectedId

  // Keep the freshest callbacks without re-binding listeners.
  const cbRef = useRef({})
  cbRef.current = { onSelectNode, onConfirmEdge, onBackground }

  // --- one-time engine + loop + input wiring ---
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const eng = {
      sim: new Map(), // id -> { x, y, vx, vy }
      camera: { x: 0, y: 0, scale: 1 },
      hoverNode: null,
      hoverEdge: null,
      reveals: new Map(), // edgeId -> t0 (ms)
      settled: false, // physics frozen once the layout is calm
      stars: [], // static background starfield (world-space)
      w: 0,
      h: 0,
      dpr: 1,
      raf: 0,
    }
    engineRef.current = eng

    // --- sizing ---
    function resize() {
      const rect = canvas.getBoundingClientRect()
      eng.dpr = Math.min(window.devicePixelRatio || 1, 2)
      eng.w = rect.width
      eng.h = rect.height
      canvas.width = Math.round(rect.width * eng.dpr)
      canvas.height = Math.round(rect.height * eng.dpr)
      if (!eng.stars.length) seedStars()
    }
    function seedStars() {
      const n = 140
      eng.stars = Array.from({ length: n }, (_, i) => ({
        x: (hash01('sx' + i) - 0.5) * 1600,
        y: (hash01('sy' + i) - 0.5) * 1200,
        r: 0.4 + hash01('sr' + i) * 1.1,
        a: 0.25 + hash01('sa' + i) * 0.5,
        tw: hash01('st' + i) * 6.28,
      }))
    }
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    resize()

    // --- coordinate transforms (CSS-pixel world; DPR handled at draw time) ---
    const toWorld = (sx, sy) => ({
      x: (sx - eng.w / 2) / eng.camera.scale - eng.camera.x,
      y: (sy - eng.h / 2) / eng.camera.scale - eng.camera.y,
    })

    function nodeAt(sx, sy) {
      const p = toWorld(sx, sy)
      const ns = nodesRef.current
      for (let i = ns.length - 1; i >= 0; i--) {
        const s = eng.sim.get(ns[i].id)
        if (!s) continue
        const r = (RADIUS[ns[i].kind] || 5) + 8
        if ((s.x - p.x) ** 2 + (s.y - p.y) ** 2 <= r * r) return ns[i]
      }
      return null
    }
    // Suggested edges expose a midpoint "invite" marker; clicking it confirms the link.
    function suggestedEdgeAt(sx, sy) {
      const p = toWorld(sx, sy)
      for (const e of edgesRef.current) {
        if (e.status !== 'suggested') continue
        const a = eng.sim.get(e.source)
        const b = eng.sim.get(e.target)
        if (!a || !b) continue
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        if ((mx - p.x) ** 2 + (my - p.y) ** 2 <= 12 * 12) return e
      }
      return null
    }

    // --- input: pan / zoom / drag / hover / click ---
    let down = null // { sx, sy, moved, node }
    canvas.addEventListener('mousedown', (ev) => {
      const node = nodeAt(ev.offsetX, ev.offsetY)
      down = { sx: ev.offsetX, sy: ev.offsetY, moved: false, node }
    })
    canvas.addEventListener('mousemove', (ev) => {
      if (down) {
        const dx = ev.offsetX - down.sx
        const dy = ev.offsetY - down.sy
        if (Math.abs(dx) + Math.abs(dy) > 3) down.moved = true
        if (down.moved) {
          if (down.node) {
            const s = eng.sim.get(down.node.id)
            const p = toWorld(ev.offsetX, ev.offsetY)
            if (s) {
              s.x = p.x
              s.y = p.y
              s.vx = s.vy = 0
              s.pinned = true
              eng.settled = false // let the rest of the map react to the drag
            }
          } else {
            eng.camera.x += dx / eng.camera.scale
            eng.camera.y += dy / eng.camera.scale
            down.sx = ev.offsetX
            down.sy = ev.offsetY
          }
        }
        return
      }
      // hover
      eng.hoverNode = nodeAt(ev.offsetX, ev.offsetY)
      eng.hoverEdge = eng.hoverNode ? null : suggestedEdgeAt(ev.offsetX, ev.offsetY)
      canvas.style.cursor = eng.hoverNode || eng.hoverEdge ? 'pointer' : 'grab'
    })
    window.addEventListener('mouseup', () => {
      if (!down) return
      const wasDrag = down.moved
      const node = down.node
      const edge = wasDrag ? null : node ? null : suggestedEdgeAt(down.sx, down.sy)
      if (node?.pinned) {
        const s = eng.sim.get(node.id)
        if (s) s.pinned = false
      }
      if (!wasDrag) {
        if (node) cbRef.current.onSelectNode?.(node)
        else if (edge) cbRef.current.onConfirmEdge?.(edge)
        else cbRef.current.onBackground?.()
      }
      down = null
    })
    canvas.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault()
        const factor = Math.exp(-ev.deltaY * 0.0012)
        const before = toWorld(ev.offsetX, ev.offsetY)
        eng.camera.scale = Math.min(3, Math.max(0.35, eng.camera.scale * factor))
        const after = toWorld(ev.offsetX, ev.offsetY)
        eng.camera.x += after.x - before.x
        eng.camera.y += after.y - before.y
      },
      { passive: false },
    )

    // --- physics: repulsion + edge springs + gentle gravity toward origin ---
    function step() {
      if (eng.settled) return // frozen once calm — nodes hold still, cheaper, easy to click
      const ns = nodesRef.current
      const es = edgesRef.current
      const sim = eng.sim
      for (const n of ns) {
        let s = sim.get(n.id)
        if (!s) continue
        if (s.pinned) continue
        let fx = -s.x * 0.012
        let fy = -s.y * 0.012 // gravity
        for (const m of ns) {
          if (m.id === n.id) continue
          const o = sim.get(m.id)
          if (!o) continue
          let dx = s.x - o.x
          let dy = s.y - o.y
          let d2 = dx * dx + dy * dy || 0.01
          const rep = 5200 / d2
          const d = Math.sqrt(d2)
          fx += (dx / d) * rep
          fy += (dy / d) * rep
        }
        s.fx = fx
        s.fy = fy
      }
      for (const e of es) {
        const a = sim.get(e.source)
        const b = sim.get(e.target)
        if (!a || !b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d = Math.hypot(dx, dy) || 0.01
        const rest = e.status === 'confirmed' ? 95 : 150
        const k = e.status === 'confirmed' ? 0.02 : 0.008
        const f = (d - rest) * k
        const ux = dx / d
        const uy = dy / d
        if (!a.pinned) {
          a.fx += ux * f
          a.fy += uy * f
        }
        if (!b.pinned) {
          b.fx -= ux * f
          b.fy -= uy * f
        }
      }
      let energy = 0
      for (const n of ns) {
        const s = sim.get(n.id)
        if (!s || s.pinned) continue
        s.vx = (s.vx + (s.fx || 0)) * 0.86
        s.vy = (s.vy + (s.fy || 0)) * 0.86
        // clamp so a cold start can't fling a star off-screen
        const vmax = 40
        s.vx = Math.max(-vmax, Math.min(vmax, s.vx))
        s.vy = Math.max(-vmax, Math.min(vmax, s.vy))
        s.x += s.vx
        s.y += s.vy
        energy += s.vx * s.vx + s.vy * s.vy
      }
      // once the layout is calm, freeze it (twinkle/pulse/reveal keep animating regardless)
      if (ns.length && energy / ns.length < 0.05) eng.settled = true
    }
    eng.wake = () => {
      eng.settled = false
    }

    // --- render ---
    function draw(now) {
      const { camera, w, h, dpr } = eng
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // deep-space background
      const g = ctx.createRadialGradient(w / 2, h * 0.42, 40, w / 2, h / 2, Math.max(w, h) * 0.75)
      g.addColorStop(0, '#101736')
      g.addColorStop(1, '#05070f')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)

      ctx.translate(w / 2, h / 2)
      ctx.scale(camera.scale, camera.scale)
      ctx.translate(camera.x, camera.y)

      // starfield (parallax-free, just depth texture)
      for (const st of eng.stars) {
        const tw = 0.6 + 0.4 * Math.sin(now * 0.001 + st.tw)
        ctx.globalAlpha = st.a * tw
        ctx.fillStyle = '#ffffff'
        ctx.beginPath()
        ctx.arc(st.x, st.y, st.r, 0, 6.2832)
        ctx.fill()
      }
      ctx.globalAlpha = 1

      const sim = eng.sim
      const ns = nodesRef.current
      const es = edgesRef.current
      const sel = selectedRef.current
      const hoverId = eng.hoverNode?.id || null
      const focusId = hoverId || sel
      const neighbors = new Set()
      if (focusId) {
        neighbors.add(focusId)
        for (const e of es) {
          if (e.source === focusId) neighbors.add(e.target)
          if (e.target === focusId) neighbors.add(e.source)
        }
      }
      const dim = (id) => (focusId && !neighbors.has(id) ? 0.28 : 1)

      // node degree → size (echoes her graph: well-connected articles read bigger)
      const degree = new Map()
      for (const e of es) {
        degree.set(e.source, (degree.get(e.source) || 0) + 1)
        degree.set(e.target, (degree.get(e.target) || 0) + 1)
      }

      // edges first (under the stars)
      ctx.lineCap = 'round'
      for (const e of es) {
        const a = sim.get(e.source)
        const b = sim.get(e.target)
        if (!a || !b) continue
        const faded = focusId ? (neighbors.has(e.source) && neighbors.has(e.target) ? 1 : 0.22) : 1
        if (e.status === 'confirmed') {
          const reveal = eng.reveals.get(e.id)
          let p = 1
          if (reveal != null) {
            p = Math.min(1, (now - reveal) / REVEAL_MS)
            if (p >= 1) eng.reveals.delete(e.id)
          }
          const ex = a.x + (b.x - a.x) * easeOut(p)
          const ey = a.y + (b.y - a.y) * easeOut(p)
          ctx.strokeStyle = `rgba(${EDGE_CONFIRMED},${0.45 * faded})`
          ctx.lineWidth = 1.4
          ctx.shadowColor = `rgba(${EDGE_CONFIRMED},0.9)`
          ctx.shadowBlur = 6
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(ex, ey)
          ctx.stroke()
          ctx.shadowBlur = 0
          // travelling particle + endpoint flare during the reveal
          if (p < 1) {
            drawGlowDot(ctx, ex, ey, 3.2, '#ffffff', '#bcd0ff')
            const flare = Math.sin(easeOut(p) * Math.PI)
            a._flare = b._flare = flare
          }
        } else {
          // suggested = dashed, pulsing "maybe" + a gold invite marker at the midpoint
          const pulse = 0.18 + 0.22 * (0.5 + 0.5 * Math.sin(now * 0.004 + hash01(e.id) * 6.28))
          ctx.strokeStyle = `rgba(${EDGE_SUGGEST},${pulse * faded})`
          ctx.lineWidth = 1
          ctx.setLineDash([5, 6])
          ctx.lineDashOffset = -now * 0.02
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
          ctx.setLineDash([])
          const mx = (a.x + b.x) / 2
          const my = (a.y + b.y) / 2
          const hovered = eng.hoverEdge?.id === e.id
          const ring = (hovered ? 6.5 : 4.5) + 1.4 * Math.sin(now * 0.005 + hash01(e.id) * 6.28)
          ctx.globalAlpha = faded
          ctx.strokeStyle = `rgba(${INVITE},${hovered ? 0.95 : 0.7})`
          ctx.lineWidth = hovered ? 2 : 1.3
          ctx.beginPath()
          ctx.arc(mx, my, Math.abs(ring), 0, 6.2832)
          ctx.stroke()
          drawGlowDot(ctx, mx, my, 1.8, '#fff7df', INVITErgb())
          ctx.globalAlpha = 1
          if (hovered && e.rationale) {
            drawHint(ctx, mx, my - 14, e.rationale)
          }
        }
      }

      // nodes
      for (const n of ns) {
        const s = sim.get(n.id)
        if (!s) continue
        const col = starColor(n)
        const deg = degree.get(n.id) || 0
        const baseR = (RADIUS[n.kind] || 5) * (1 + Math.min(deg, 8) * 0.1)
        const tw = 0.85 + 0.15 * Math.sin(now * 0.002 + hash01(n.id) * 6.28)
        const isFocus = n.id === focusId
        const a = dim(n.id)
        const flare = s._flare || 0
        s._flare = Math.max(0, flare - 0.04)

        ctx.globalAlpha = a
        // glow halo
        const R = baseR * (1 + 0.9 * flare) + (isFocus ? 3 : 0)
        const halo = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, R * 3.4)
        halo.addColorStop(0, hexA(col.glow, 0.55 * tw + 0.4 * flare))
        halo.addColorStop(1, hexA(col.glow, 0))
        ctx.fillStyle = halo
        ctx.beginPath()
        ctx.arc(s.x, s.y, R * 3.4, 0, 6.2832)
        ctx.fill()
        // core
        ctx.fillStyle = col.core
        ctx.beginPath()
        ctx.arc(s.x, s.y, R, 0, 6.2832)
        ctx.fill()
        // 4-point glint for the bright anchors
        if (n.kind === 'northStar' || flare > 0.05) {
          drawGlint(ctx, s.x, s.y, R * (2.4 + flare * 2), hexA('#ffffff', 0.6 * tw + flare))
        }
        if (isFocus) {
          ctx.strokeStyle = hexA(col.core, 0.9)
          ctx.lineWidth = 1.2
          ctx.beginPath()
          ctx.arc(s.x, s.y, R + 4, 0, 6.2832)
          ctx.stroke()
        }
        // labels: anchors + concepts always; bare papers (legacy) only on focus/hover
        const isAnchor = n.kind === 'northStar' || n.kind === 'project'
        const showLabel = n.kind !== 'paper' || isFocus
        if (showLabel) {
          const label = isAnchor ? n.label : truncate(n.label, 34)
          ctx.font = `${n.kind === 'northStar' ? 600 : 400} ${isAnchor ? 12 : 11}px ui-sans-serif, system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          ctx.fillStyle = hexA('#e8efff', isFocus ? 0.98 : 0.72)
          ctx.shadowColor = 'rgba(0,0,0,0.8)'
          ctx.shadowBlur = 4
          ctx.fillText(label, s.x, s.y + R + 5)
          ctx.shadowBlur = 0
        }
        ctx.globalAlpha = 1
      }
    }

    function frame(now) {
      step()
      draw(now)
      eng.raf = requestAnimationFrame(frame)
    }
    eng.raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(eng.raf)
      ro.disconnect()
    }
  }, [])

  // --- reconcile sim nodes when the node set changes (keep existing positions) ---
  useEffect(() => {
    const eng = engineRef.current
    if (!eng) return
    const sim = eng.sim
    const ids = new Set(nodes.map((n) => n.id))
    for (const id of [...sim.keys()]) if (!ids.has(id)) sim.delete(id)
    let added = false
    nodes.forEach((n, i) => {
      if (sim.has(n.id)) return
      // seed anchors on a ring, content near center; deterministic jitter from the id
      const ang = hash01(n.id) * 6.2832
      const isAnchor = n.kind === 'northStar' || n.kind === 'project'
      const rad = isAnchor ? 150 : 40 + hash01('r' + n.id) * 60
      sim.set(n.id, { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad, vx: 0, vy: 0 })
      added = true
    })
    if (added) eng.settled = false // new star → re-settle the layout
  }, [nodes])

  // --- detect suggested→confirmed transitions and enqueue the reveal animation ---
  const prevStatus = useRef(new Map())
  useEffect(() => {
    const eng = engineRef.current
    const prev = prevStatus.current
    const next = new Map()
    for (const e of edges) {
      next.set(e.id, e.status)
      if (eng && e.status === 'confirmed' && prev.get(e.id) === 'suggested') {
        eng.reveals.set(e.id, performance.now())
        eng.settled = false // a new constellation line changes the pull — let it re-settle
      }
    }
    prevStatus.current = next
  }, [edges])

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full touch-none select-none rounded-xl"
      style={{ display: 'block', cursor: 'grab' }}
    />
  )
}

// --- little canvas helpers ---
function easeOut(p) {
  return 1 - Math.pow(1 - p, 3)
}
function INVITErgb() {
  return '#ffd36b'
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`
}
function drawGlowDot(ctx, x, y, r, core, glow) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3)
  g.addColorStop(0, glow)
  g.addColorStop(1, hexA(typeof glow === 'string' && glow.startsWith('#') ? glow : '#6fa8ff', 0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, r * 3, 0, 6.2832)
  ctx.fill()
  ctx.fillStyle = core
  ctx.beginPath()
  ctx.arc(x, y, r, 0, 6.2832)
  ctx.fill()
}
function drawGlint(ctx, x, y, len, color) {
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x - len, y)
  ctx.lineTo(x + len, y)
  ctx.moveTo(x, y - len)
  ctx.lineTo(x, y + len)
  ctx.stroke()
}
function drawHint(ctx, x, y, text) {
  const t = truncate(text, 52)
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  const w = ctx.measureText(t).width + 14
  ctx.fillStyle = 'rgba(10,14,30,0.9)'
  roundRect(ctx, x - w / 2, y - 20, w, 18, 5)
  ctx.fill()
  ctx.fillStyle = '#ffe9b8'
  ctx.fillText(t, x, y - 4)
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
function truncate(s, n) {
  return s && s.length > n ? s.slice(0, n - 1) + '…' : s || ''
}
