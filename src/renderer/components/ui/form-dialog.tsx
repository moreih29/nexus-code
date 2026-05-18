/**
 * FormDialog — renderer-side modal form primitive for multi-field prompts.
 *
 * Uses the same Radix Dialog + Button visual conventions as PromptDialog while
 * allowing callers to host several validated fields in one
 * focused modal. Escape and outside-click dismissal both flow through
 * onCancel via Radix's onOpenChange contract.
 */

import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useState } from "react";
import { Button } from "./button";

export type FormDialogValues = Record<string, string>;

export interface FormDialogField {
  name: string;
  label: string;
  type?: React.HTMLInputTypeAttribute;
  multiline?: boolean;
  placeholder?: string;
  defaultValue?: string;
  helperText?: string;
  required?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  inputClassName?: string;
  validate?: (value: string, values: FormDialogValues) => string | null | undefined;
}

export interface FormDialogFieldState {
  field: FormDialogField;
  value: string;
  error: string | null;
}

export interface FormDialogProps {
  open: boolean;
  title: string;
  description?: string;
  fields: readonly FormDialogField[];
  submitLabel: string;
  cancelLabel?: string;
  errorClassName?: string;
  busy?: boolean;
  initialValues?: FormDialogValues;
  extraContent?: React.ReactNode;
  onCancel: () => void;
  onSubmit: (payload: { values: FormDialogValues }) => void;
}

interface FormDialogContentProps {
  title: string;
  description?: string;
  fields: readonly FormDialogField[];
  values: FormDialogValues;
  busy?: boolean;
  submitLabel: string;
  cancelLabel: string;
  errorClassName?: string;
  extraContent?: React.ReactNode;
  onValueChange: (name: string, value: string) => void;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  renderFieldAccessory?: (state: FormDialogFieldState) => React.ReactNode;
  children?: React.ReactNode;
}

/**
 * Builds the initial value map from field defaults and caller overrides.
 * Caller-provided values win so a dialog can reopen with an edited draft.
 */
export function initialFormDialogValues(
  fields: readonly FormDialogField[],
  initialValues: FormDialogValues = {},
): FormDialogValues {
  const values: FormDialogValues = {};
  for (const field of fields) {
    values[field.name] = initialValues[field.name] ?? field.defaultValue ?? "";
  }
  return values;
}

/**
 * Returns per-field validation state using the dialog's required-field rule
 * and optional custom validator. Required defaults to true to keep submit
 * disablement safe by default.
 */
export function getFormDialogFieldStates(
  fields: readonly FormDialogField[],
  values: FormDialogValues,
): FormDialogFieldState[] {
  return fields.map((field) => {
    const value = values[field.name] ?? "";
    const required = field.required !== false;
    const requiredError = required && value.trim().length === 0 ? "Required" : null;
    const customError = requiredError ? null : (field.validate?.(value, values) ?? null);
    return { field, value, error: requiredError ?? customError };
  });
}

/**
 * True when the dialog should block submit for pending work, missing required
 * values, or inline validation errors.
 */
export function isFormDialogSubmitDisabled(
  fields: readonly FormDialogField[],
  values: FormDialogValues,
  busy = false,
): boolean {
  return busy || getFormDialogFieldStates(fields, values).some((state) => state.error !== null);
}

/**
 * Adapts Radix Dialog's open-state callback to the FormDialog cancel contract.
 * Radix sends false for Escape and outside pointer dismissal, so both routes
 * resolve through the same caller-provided onCancel handler.
 */
export function handleFormDialogOpenChange(nextOpen: boolean, onCancel: () => void): void {
  if (!nextOpen) onCancel();
}

/**
 * Renders the form body without the Radix portal so unit tests can assert the
 * field layout in a no-DOM server-render environment.
 */
export function FormDialogContent({
  title,
  description,
  fields,
  values,
  busy = false,
  submitLabel,
  cancelLabel,
  errorClassName = "text-destructive",
  extraContent,
  onValueChange,
  onCancel,
  onSubmit,
  renderFieldAccessory,
  children,
}: FormDialogContentProps): React.JSX.Element {
  const fieldStates = getFormDialogFieldStates(fields, values);
  const submitDisabled = isFormDialogSubmitDisabled(fields, values, busy);

  return (
    <>
      <div className="text-app-body-emphasis text-foreground" aria-hidden="true">
        {title}
      </div>
      {description ? (
        <div className="mt-2 text-app-ui-sm text-muted-foreground" aria-hidden="true">
          {description}
        </div>
      ) : null}
      <form className="mt-4 flex flex-col gap-3" onSubmit={onSubmit}>
        {extraContent}
        {fieldStates.map(({ field, value, error }) => {
          const inputId = `form-dialog-${field.name}`;
          const helpId = `${inputId}-help`;
          return (
            <div key={field.name} className="flex flex-col gap-2">
              <label htmlFor={inputId} className="text-app-ui-sm text-foreground">
                {field.label}
              </label>
              <div className="flex items-center gap-2">
                {field.multiline ? (
                  <textarea
                    id={inputId}
                    name={field.name}
                    value={value}
                    onChange={(event) => onValueChange(field.name, event.target.value)}
                    placeholder={field.placeholder}
                    className={`min-h-20 w-full resize-y rounded-(--radius-control) border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring ${field.inputClassName ?? ""}`}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error || field.helperText ? helpId : undefined}
                    disabled={busy}
                    readOnly={field.readOnly}
                    // biome-ignore lint/a11y/noAutofocus: callers opt in for modal keyboard flow.
                    autoFocus={field.autoFocus}
                  />
                ) : (
                  <input
                    id={inputId}
                    name={field.name}
                    type={field.type ?? "text"}
                    value={value}
                    onChange={(event) => onValueChange(field.name, event.target.value)}
                    placeholder={field.placeholder}
                    className={`w-full rounded-(--radius-control) border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring ${field.inputClassName ?? ""}`}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error || field.helperText ? helpId : undefined}
                    disabled={busy}
                    readOnly={field.readOnly}
                    // biome-ignore lint/a11y/noAutofocus: callers opt in for modal keyboard flow.
                    autoFocus={field.autoFocus}
                  />
                )}
                {renderFieldAccessory?.({ field, value, error })}
              </div>
              {error ? (
                <p id={helpId} className={`text-app-ui-sm ${errorClassName}`}>
                  {error}
                </p>
              ) : field.helperText ? (
                <p id={helpId} className="text-app-ui-sm text-muted-foreground">
                  {field.helperText}
                </p>
              ) : null}
            </div>
          );
        })}
        {children}
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button type="submit" size="sm" disabled={submitDisabled}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </>
  );
}

/**
 * Mounts the validated form inside a Radix Dialog. The value state resets when
 * the dialog opens so callers can reuse the same component across prompts.
 */
export function FormDialog({
  open,
  title,
  description,
  fields,
  submitLabel,
  cancelLabel = "Cancel",
  errorClassName,
  busy = false,
  initialValues,
  extraContent,
  onCancel,
  onSubmit,
}: FormDialogProps): React.JSX.Element {
  const [values, setValues] = useState<FormDialogValues>(() =>
    initialFormDialogValues(fields, initialValues),
  );

  useEffect(() => {
    if (!open) return;
    setValues(initialFormDialogValues(fields, initialValues));
  }, [open, fields, initialValues]);

  function handleValueChange(name: string, value: string): void {
    setValues((current) => ({ ...current, [name]: value }));
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (isFormDialogSubmitDisabled(fields, values, busy)) return;
    onSubmit({ values });
  }

  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(nextOpen) => handleFormDialogOpenChange(nextOpen, onCancel)}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <RadixDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[480px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-(--radius-island) border border-border bg-background p-5 text-foreground shadow-none outline-none">
          <RadixDialog.Title className="sr-only">{title}</RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className="sr-only">{description}</RadixDialog.Description>
          ) : (
            <RadixDialog.Description className="sr-only" />
          )}
          <FormDialogContent
            title={title}
            description={description}
            fields={fields}
            values={values}
            busy={busy}
            submitLabel={submitLabel}
            cancelLabel={cancelLabel}
            errorClassName={errorClassName}
            extraContent={extraContent}
            onValueChange={handleValueChange}
            onCancel={onCancel}
            onSubmit={handleSubmit}
          />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
