import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from "react";

export interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> {
  value: number;
  onValueChange: (next: number) => void;
  integer?: boolean;
  fallback?: number;
  commitMin?: number;
  commitMax?: number;
  clampOnBlur?: boolean;
  normalize?: (val: number) => number;
}

/** Numeric text input that allows clearing/editing freely without inserting a sticky leading `0`. */
export function NumberInput({
  value,
  onValueChange,
  integer = false,
  fallback,
  commitMin,
  commitMax,
  clampOnBlur = false,
  normalize,
  min,
  max,
  step,
  onFocus,
  onBlur,
  onKeyDown,
  ...rest
}: NumberInputProps) {
  const [text, setText] = useState<string>(() => (Number.isFinite(value) ? String(value) : ""));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setText(Number.isFinite(value) ? String(value) : "");
    }
  }, [value]);

  const numMin = typeof min === "number" ? min : min !== undefined ? Number(min) : undefined;
  const numMax = typeof max === "number" ? max : max !== undefined ? Number(max) : undefined;

  const stripLeadingZeros = (raw: string): string => {
    // Strip accidental leading zeros before digits (e.g. "050" -> "50", "-05" -> "-5"),
    // while keeping "0", "0.", "0.5", "-0", "-0.5".
    return raw.replace(/^(-?)0+(\d)/, "$1$2");
  };

  const applyBounds = (num: number): number => {
    let next = integer ? Math.trunc(num) : num;
    if (normalize) {
      next = normalize(next);
    }
    if (clampOnBlur) {
      if (numMin !== undefined && Number.isFinite(numMin)) {
        next = Math.max(numMin, next);
      }
      if (numMax !== undefined && Number.isFinite(numMax)) {
        next = Math.min(numMax, next);
      }
    }
    return next;
  };

  const handleChange = (rawInput: string) => {
    const cleaned = rawInput
      .replace(/[^\d.-]/g, "")
      .replace(/(?!^)-/g, "");
    const singleDot = integer
      ? cleaned.replace(/\./g, "")
      : cleaned.replace(/^([^.]*\.)(.*)$/, (_, head: string, tail: string) => {
          return head + tail.replace(/\./g, "");
        });

    const normalizedText = stripLeadingZeros(singleDot);
    setText(normalizedText);

    if (
      normalizedText === "" ||
      normalizedText === "-" ||
      normalizedText === "." ||
      normalizedText === "-."
    ) {
      return;
    }

    const parsed = integer
      ? Number.parseInt(normalizedText, 10)
      : Number.parseFloat(normalizedText);
    if (!Number.isFinite(parsed)) return;

    const finalNum = integer ? Math.trunc(parsed) : parsed;
    if (commitMin !== undefined && finalNum < commitMin) return;
    if (commitMax !== undefined && finalNum > commitMax) return;
    onValueChange(finalNum);
  };

  const handleFocus = (e: FocusEvent<HTMLInputElement>) => {
    focusedRef.current = true;
    onFocus?.(e);
  };

  const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
    focusedRef.current = false;
    const trimmed = text.trim();
    if (trimmed === "" || trimmed === "-" || trimmed === "." || trimmed === "-.") {
      const restored = applyBounds(fallback ?? value);
      if (Number.isFinite(restored)) {
        setText(String(restored));
        if (restored !== value) onValueChange(restored);
      } else {
        setText("");
      }
      onBlur?.(e);
      return;
    }

    const parsed = integer ? Number.parseInt(trimmed, 10) : Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed)) {
      const restored = applyBounds(fallback ?? value);
      setText(Number.isFinite(restored) ? String(restored) : "");
      if (Number.isFinite(restored) && restored !== value) {
        onValueChange(restored);
      }
      onBlur?.(e);
      return;
    }

    const bounded = applyBounds(parsed);
    setText(String(bounded));
    if (bounded !== value) {
      onValueChange(bounded);
    }
    onBlur?.(e);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const stepNum = typeof step === "number" ? step : step ? Number(step) : 1;
      const delta = (Number.isFinite(stepNum) && stepNum > 0 ? stepNum : 1) * (e.key === "ArrowUp" ? 1 : -1);
      const cur = Number.parseFloat(text);
      const base = Number.isFinite(cur) ? cur : value;
      let next = Number((base + delta).toFixed(6));
      if (integer) next = Math.round(next);
      if (normalize) next = normalize(next);
      if (numMin !== undefined && Number.isFinite(numMin)) next = Math.max(numMin, next);
      if (numMax !== undefined && Number.isFinite(numMax)) next = Math.min(numMax, next);
      setText(String(next));
      onValueChange(next);
    }
    onKeyDown?.(e);
  };

  return (
    <input
      {...rest}
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      value={text}
      onChange={(e) => handleChange(e.target.value)}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
}
