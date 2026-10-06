/**
 * Minimal stand-in for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The real package pulls shiki, simple-icons, katex and a large CSS-module graph,
 * none of which are resolvable outside the browser bundle. This stub keeps the
 * same public shapes for exactly the members dsh-model-fold consumes, so the
 * bundle's own logic and markup can be rendered and asserted in Node.
 */
import { createRequire } from 'node:module'

const require = createRequire(process.env.DMF_REQUIRE_BASE ?? import.meta.url)
const React = require('react')
const h = React.createElement

const icon = (name) => {
  const Component = (props) => h('svg', { ...props, 'data-icon': name })
  Component.displayName = name
  return Component
}

export const IconCheckOutlineRegular = icon('CheckOutline')
export const IconChevronDownOutlineRegular = icon('ChevronDown')
export const IconChevronRightOutlineRegular = icon('ChevronRight')
export const IconCloseFillRegular = icon('CloseFill')
export const IconDataOutlineRegular = icon('DataOutline')
export const IconWarningOutlineRegular = icon('WarningOutline')

export const StateDot = ({ state }) => h('span', { 'data-state-dot': state })

export const Input = React.forwardRef(function Input({ icon: leading, className, ...rest }, ref) {
  return h(
    'span',
    { className },
    leading != null ? h('span', {}, leading) : null,
    h('input', { ref, ...rest }),
  )
})

export const MenuSurface = React.forwardRef(function MenuSurface(
  { compact, className, style, children, ...props },
  ref,
) {
  return h('div', { ...props, ref, className, style }, h('div', { 'aria-hidden': 'true' }), children)
})

export const Toast = ({ text, onDone }) => h('div', { 'data-toast': text })

/** Real implementation is a scored subsequence match; a substring filter suffices here. */
export function rankByName(items, rawQuery) {
  const query = rawQuery.toLowerCase()
  if (query === '') return items
  return items.filter((item) => item.name.toLowerCase().includes(query))
}
