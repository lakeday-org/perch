using Stockroom.Reporting;

namespace Stockroom
{
    /// <summary>The stock levels of one site, by SKU.</summary>
    public sealed class Warehouse
    {
        private readonly Dictionary<string, StockLevel> _levels = new();

        public Warehouse(string name)
        {
            Name = name;
        }

        public string Name { get; }

        public StockLevel Stock(Sku sku, int onHand, int reorderPoint = 0)
        {
            if (_levels.ContainsKey(sku.Code)) throw new ArgumentException($"{sku} is already stocked here", nameof(sku));
            var level = new StockLevel(sku, onHand, reorderPoint);
            _levels[sku.Code] = level;
            return level;
        }

        public StockLevel LevelOf(Sku sku)
        {
            if (!_levels.TryGetValue(sku.Code, out var level)) throw new KeyNotFoundException($"{Name} does not stock {sku}");
            return level;
        }

        /// <summary>Promises each line of an order, or none of them when one cannot be met.</summary>
        public bool Reserve(IReadOnlyList<(Sku Sku, int Quantity)> lines)
        {
            foreach (var (sku, quantity) in lines)
            {
                if (LevelOf(sku).Available() < quantity) return false;
            }
            foreach (var (sku, quantity) in lines)
            {
                LevelOf(sku).Reserve(quantity);
            }
            return true;
        }

        public ReorderReport Reorders()
        {
            var report = new ReorderReport(Name);
            foreach (var level in _levels.Values)
            {
                if (level.NeedsReorder()) report.Add(level);
            }
            return report;
        }
    }
}
