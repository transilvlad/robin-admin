import { Input } from '../ui/Input';
import { OPERATION_FIELDS, type OperationsNumericKey, type OperationsPolicy } from '../../constants/operationsSettings';
export function OperationsPolicyFields({ section, policy, onChange, disabled = false }: {
  section: 'alerts' | 'fleet' | 'reporting';
  policy: Partial<OperationsPolicy>;
  onChange: (key: OperationsNumericKey, value: number) => void;
  disabled?: boolean;
}) {
  return <div className="grid gap-4 md:grid-cols-2">
    {OPERATION_FIELDS.filter(field => field[5] === section).map(([key, label, fallback, min, max]) => (
      <Input key={key} label={label} type="number" min={min} max={max} step={1}
        value={policy[key] ?? fallback} disabled={disabled}
        onChange={event => onChange(key, Number(event.target.value))} />
    ))}
  </div>;
}
