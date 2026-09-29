// @vitest-environment jsdom
// 前端冒烟（engineering-standards §3：组件测试不设标准层，仅冒烟）
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import Login from './pages/Login'

const loginFetch = vi.fn(async () =>
  new Response(JSON.stringify({ member: { id: 1, name: '甲', role: 'admin' } }), { status: 200 })
)

beforeEach(() => {
  cleanup()
  loginFetch.mockClear()
  globalThis.fetch = loginFetch as unknown as typeof fetch
})

describe('前端冒烟', () => {
  it('Login 渲染品牌与表单，按钮在填写前禁用', () => {
    render(<Login onLogin={async () => {}} />)
    expect(screen.getByText('🧠 项目大脑')).toBeTruthy()
    expect(screen.getAllByRole('textbox').length).toBe(1)
    expect((screen.getByRole('button', { name: '登录' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('填写后提交：调用登录接口并触发 onLogin', async () => {
    const onLogin = vi.fn(async () => {})
    const { container } = render(<Login onLogin={onLogin} />)
    const inputs = container.querySelectorAll('input')
    fireEvent.change(inputs[0], { target: { value: 'admin' } })
    fireEvent.change(inputs[1], { target: { value: 'secret-1' } })
    const btn = screen.getByRole('button', { name: '登录' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    await waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1))
    expect(loginFetch).toHaveBeenCalledWith('/api/v1/auth/login', expect.objectContaining({ method: 'POST' }))
  })
})
