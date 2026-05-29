/**
 * VENDORED from Kliovo-Dine: src/lib/format-paisa.ts
 * Keep in sync with the canonical source. Pure, no dependencies.
 *
 * Converts an amount in paisa (integer, x100) to a formatted PKR string.
 *   123400 => "Rs 1,234"   50 => "Rs 0.50"   0 => "Rs 0"
 */
export function formatPaisa(amountPaisa: number): string {
  const rupees = amountPaisa / 100;
  const isWholeNumber = amountPaisa % 100 === 0;

  if (isWholeNumber) {
    return `Rs ${Math.floor(rupees).toLocaleString("en-PK")}`;
  }

  return `Rs ${rupees.toLocaleString("en-PK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
