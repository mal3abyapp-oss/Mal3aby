import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from './App'

describe('App', () => {
  it('renders the public homepage by default', () => {
    render(<App />)
    expect(screen.getByText('إدارة ناديك وأكاديميتك وملاعبك من مكان واحد')).toBeInTheDocument()
  })

  it('sets document direction to rtl by default', () => {
    render(<App />)
    expect(document.documentElement.dir).toBe('rtl')
  })
})
