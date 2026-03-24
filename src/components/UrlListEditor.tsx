import { useState, useRef, KeyboardEvent } from 'react';
import { X, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ExternalFavicon } from '@/components/ExternalFavicon';
import { cn } from '@/lib/utils';

interface UrlListEditorProps {
  /** Label shown above the list */
  label: string;
  /** Current array of full URLs */
  items: string[];
  /** Called when the list changes */
  onChange: (items: string[]) => void;
  /** Controls auto-prefix on bare domain entry */
  protocol: 'wss' | 'https';
  /** Placeholder shown in the add input */
  placeholder?: string;
  /** Whether to show the required asterisk */
  required?: boolean;
  /** Additional CSS classes for the root element */
  className?: string;
}

/**
 * Normalize a bare domain or partial URL to a fully-qualified URL.
 * If the value already has any protocol it is returned as-is.
 */
function normalizeEntry(value: string, protocol: 'wss' | 'https'): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^wss?:\/\//i.test(trimmed) || /^https?:\/\//i.test(trimmed)) return trimmed;
  return `${protocol}://${trimmed}`;
}

/**
 * Convert a URL to an https:// form suitable for favicon lookup.
 * wss:// → https://, ws:// → http://
 */
function toHttpsUrl(url: string): string {
  return url.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
}

/** Strip the protocol prefix for compact display */
function displayLabel(url: string): string {
  return url.replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '');
}

export function UrlListEditor({
  label,
  items,
  onChange,
  protocol,
  placeholder,
  required,
  className,
}: UrlListEditorProps) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleAdd = () => {
    const normalized = normalizeEntry(inputValue, protocol);
    if (!normalized) return;
    // Silently ignore duplicates
    if (items.includes(normalized)) {
      setInputValue('');
      return;
    }
    onChange([...items, normalized]);
    setInputValue('');
    inputRef.current?.focus();
  };

  const handleRemove = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <div className={cn('grid gap-2', className)}>
      <Label>
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </Label>

      {/* Scrollable list of existing items */}
      {items.length > 0 && (
        <div className="rounded-md border overflow-y-auto max-h-48">
          {items.map((item, index) => (
            <div
              key={index}
              className="flex items-center gap-2 px-3 py-2 hover:bg-muted border-b last:border-b-0"
            >
              <ExternalFavicon
                url={toHttpsUrl(item)}
                size={14}
                className="shrink-0 opacity-70"
              />
              <span className="flex-1 text-sm font-mono truncate">
                {displayLabel(item)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => handleRemove(index)}
                aria-label={`Remove ${item}`}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Add input */}
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? (protocol === 'wss' ? 'relay.example.com' : 'server.example.com')}
          className="font-mono text-sm"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={handleAdd}
          disabled={!inputValue.trim()}
          aria-label={`Add ${label}`}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
