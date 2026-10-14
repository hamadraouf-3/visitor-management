import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Field'
import { Input } from '../components/ui/Input'
import { RadioGroup } from '../components/ui/RadioGroup'
import type { FormErrors, ServerFieldPaths } from '../utils/forms'
import { useFormErrors } from './useFormErrors'

type WalkInField = 'name' | 'email' | 'reason'

// Declared out of on-screen order on purpose: focus follows the document, not this object.
const FIELDS: ServerFieldPaths<WalkInField> = { reason: 'reason', name: 'visitor.full_name', email: 'visitor.email' }

const REASONS = [
  { value: 'DELIVERY', label: 'Delivery' },
  { value: 'OTHER', label: 'Other' },
] as const

interface WalkInFormProps {
  serverError?: unknown
  validation?: FormErrors<WalkInField>
  initialReason?: 'DELIVERY' | 'OTHER' | null
  onSend?: () => void
}

function WalkInForm({ serverError = null, validation = {}, initialReason = null, onSend = () => {} }: WalkInFormProps) {
  const form = useFormErrors(serverError, { fields: FIELDS })
  const [reason, setReason] = useState(initialReason)
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (form.validate(validation)) onSend()
      }}
    >
      {form.formError && <p role="alert">{form.formError}</p>}
      <Field label="Name" {...form.field('name')}>
        <Input />
      </Field>
      <Field label="Email" {...form.field('email')}>
        <Input />
      </Field>
      <RadioGroup label="Reason" options={REASONS} value={reason} onValueChange={setReason} {...form.field('reason')} />
      <Button type="submit">Register</Button>
    </form>
  )
}

function validationError(fields: Record<string, string>): ApiError {
  return new ApiError({ status: 422, code: 'VALIDATION_ERROR', message: 'Please correct the highlighted fields.', details: { fields } })
}

/** Records whether the control already showed its error when it received focus. */
function invalidAtFocus(element: HTMLElement): () => boolean | null {
  let state: boolean | null = null
  element.addEventListener('focus', () => {
    state = element.getAttribute('aria-invalid') === 'true' && Boolean(element.getAttribute('aria-describedby'))
  })
  return () => state
}

describe('useFormErrors', () => {
  it('focuses the first invalid control in document order after failed client validation, once its error shows', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn<() => void>()
    render(<WalkInForm validation={{ reason: 'Choose a reason.', email: 'Enter a valid email address.' }} onSend={onSend} />)
    const email = screen.getByLabelText('Email')
    const wasInvalidAtFocus = invalidAtFocus(email)

    await user.click(screen.getByRole('button', { name: 'Register' }))

    expect(email).toHaveFocus()
    expect(wasInvalidAtFocus()).toBe(true)
    expect(email).toHaveAccessibleDescription('Enter a valid email address.')
    expect(screen.getByText('Choose a reason.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('focuses a radio group through its first radio, or the selected one', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<WalkInForm validation={{ reason: 'Choose a reason.' }} />)

    await user.click(screen.getByRole('button', { name: 'Register' }))
    expect(screen.getByRole('radio', { name: 'Delivery' })).toHaveFocus()
    unmount()

    render(<WalkInForm validation={{ reason: 'Notes are required for Other.' }} initialReason="OTHER" />)
    await user.click(screen.getByRole('button', { name: 'Register' }))
    expect(screen.getByRole('radio', { name: 'Other' })).toHaveFocus()
  })

  it('sends a valid form without moving focus', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn<() => void>()
    render(<WalkInForm onSend={onSend} />)
    const submit = screen.getByRole('button', { name: 'Register' })

    await user.click(submit)

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(submit).toHaveFocus()
  })

  it('shows server field messages on their fields and focuses the first one, for every new error', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<WalkInForm />)
    const name = screen.getByLabelText('Name')
    const submit = screen.getByRole('button', { name: 'Register' })
    submit.focus()

    rerender(<WalkInForm serverError={validationError({ 'visitor.email': 'Enter a valid email address.', 'visitor.full_name': 'This field is required.' })} />)

    expect(name).toHaveFocus()
    expect(name).toHaveAccessibleDescription('This field is required.')
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Enter a valid email address.')
    expect(screen.queryByRole('alert')).toBeNull()

    // The next failed submit focuses again, even with the same messages.
    await user.click(submit)
    rerender(<WalkInForm serverError={null} />)
    rerender(<WalkInForm serverError={validationError({ 'visitor.full_name': 'This field is required.' })} />)
    expect(name).toHaveFocus()
  })

  it('shows errors no field can show in the form alert and leaves focus where it is', () => {
    const { rerender } = render(<WalkInForm />)
    const submit = screen.getByRole('button', { name: 'Register' })
    submit.focus()

    rerender(
      <WalkInForm serverError={new ApiError({ status: 409, code: 'WALK_INS_DISABLED', message: 'Walk-in registration is disabled for this company.' })} />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Walk-in registration is disabled for this company.')
    expect(submit).toHaveFocus()
  })

  it('shows a client message instead of a stale server message for the same field', async () => {
    const user = userEvent.setup()
    render(
      <WalkInForm
        serverError={validationError({ 'visitor.email': 'This email address is not valid.' })}
        validation={{ email: 'Enter your email address.' }}
      />,
    )

    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('This email address is not valid.')

    await user.click(screen.getByRole('button', { name: 'Register' }))

    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Enter your email address.')
    expect(screen.getByLabelText('Email')).toHaveFocus()
  })
})

const checkName = (value: string) => ({ name: value.trim() ? undefined : 'Enter a name.' })

function NameForm() {
  const form = useFormErrors<'name'>(null, { fields: { name: 'name' } })
  const [name, setName] = useState('')
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        form.validate(checkName(name))
      }}
    >
      <Field label="Name" {...form.field('name')}>
        <Input
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            if (form.attempted) form.refresh(checkName(event.target.value))
          }}
        />
      </Field>
      <Button type="submit">Save</Button>
    </form>
  )
}

describe('re-checking a form as it is corrected (refresh)', () => {
  it('drops a message as soon as its field is right, without moving focus', async () => {
    const user = userEvent.setup()
    render(<NameForm />)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Enter a name.')).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveFocus()
    await user.type(screen.getByLabelText('Name'), 'Lina')
    expect(screen.queryByText('Enter a name.')).not.toBeInTheDocument()
    await user.clear(screen.getByLabelText('Name'))
    expect(screen.getByText('Enter a name.')).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveFocus()
  })
})
