namespace Stockroom
{
    /// <summary>A stock-keeping unit: an upper-case code of letters and digits, four to twelve long.</summary>
    public sealed class Sku
    {
        private Sku(string code)
        {
            Code = code;
        }

        public string Code { get; }

        public static Sku Parse(string text)
        {
            var code = text.Trim().ToUpperInvariant();
            if (code.Length < 4 || code.Length > 12) throw new FormatException($"a SKU is 4 to 12 characters, not {code.Length}");
            foreach (var character in code)
            {
                if (!char.IsLetterOrDigit(character) && character != '-') throw new FormatException($"'{character}' cannot be in a SKU");
            }
            return new Sku(code);
        }

        public override bool Equals(object? other) => other is Sku sku && sku.Code == Code;

        public override int GetHashCode() => Code.GetHashCode();

        public override string ToString() => Code;
    }
}
