using System.Text;

namespace Stockroom.Reporting
{
    /// <summary>The SKUs of one warehouse at or below their reorder points, and how many to order to get back above them.</summary>
    public sealed class ReorderReport
    {
        private readonly List<StockLevel> _lines = new();

        public ReorderReport(string warehouse)
        {
            Warehouse = warehouse;
        }

        public string Warehouse { get; }
        public int Count => _lines.Count;

        public void Add(StockLevel level) => _lines.Add(level);

        /// <summary>Enough to double the reorder point, less what is already available.</summary>
        public static int SuggestedOrder(StockLevel level)
        {
            var target = level.ReorderPoint * 2;
            var shortfall = target - level.Available();
            return shortfall > 0 ? shortfall : 0;
        }

        public string Render()
        {
            var text = new StringBuilder();
            text.AppendLine($"Reorder: {Warehouse}");
            foreach (var level in _lines)
            {
                text.AppendLine($"  {level.Sku} available {level.Available()} order {SuggestedOrder(level)}");
            }
            return text.ToString();
        }
    }
}
