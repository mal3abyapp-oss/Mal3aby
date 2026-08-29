import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from './App'

describe('App', () => {
  it('renders the public homepage by default', () => {
    render(<App />)
    // Landing page redesign (2026-08-29): matched by a stable substring
    // of the hero headline rather than the full string, since the
    // headline now spans two lines (whitespace-pre-line) -- a partial
    // match keeps this test from breaking on future copy wording
    // tweaks while still proving the real homepage rendered.
    expect(screen.getByText(/نادك، كله، في مكان واحد/)).toBeInTheDocument()
  })

  it('sets document direction to rtl by default', () => {
    render(<App />)
    expect(document.documentElement.dir).toBe('rtl')
  })
})
