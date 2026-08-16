// Cutting a JavaScript string cuts UTF-16 code units, so a cut that lands
// between the halves of a surrogate pair leaves a lone surrogate. Convex's
// response serializer rejects those outright ("unexpected end of hex escape"),
// which took down newsletter search for any page holding an emoji at the
// boundary. A trailing low surrogate is already complete: its high half is
// inside the slice.
export function truncateSafe(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
