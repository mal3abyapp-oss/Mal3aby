import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from './App'

describe('App', () => {
  it('renders the Phase-0 placeholder shell in Arabic RTL', () => {
    render(<App />)
    expect(screen.getByText('ملعبي | Mala3by — قيد الإعداد')).toBeInTheDocument()
  })
})
