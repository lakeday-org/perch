namespace Stockroom
{
    /// <summary>How many of one SKU are on hand, how many are promised to orders, and when to reorder.</summary>
    public sealed class StockLevel
    {
        public StockLevel(Sku sku, int onHand, int reorderPoint)
        {
            if (onHand < 0) throw new ArgumentOutOfRangeException(nameof(onHand), "stock on hand cannot be negative");
            Sku = sku;
            OnHand = onHand;
            ReorderPoint = reorderPoint;
        }

        public Sku Sku { get; }
        public int OnHand { get; private set; }
        public int Reserved { get; private set; }
        public int ReorderPoint { get; }

        /// <summary>What can still be promised: on hand less what already is.</summary>
        public int Available() => OnHand - Reserved;

        public void Receive(int quantity)
        {
            if (quantity <= 0) throw new ArgumentOutOfRangeException(nameof(quantity), "a receipt is a positive quantity");
            OnHand += quantity;
        }

        /// <summary>Promises stock to an order; more than is available is refused rather than oversold.</summary>
        public bool Reserve(int quantity)
        {
            if (quantity <= 0) throw new ArgumentOutOfRangeException(nameof(quantity), "a reservation is a positive quantity");
            if (quantity > Available()) return false;
            Reserved += quantity;
            return true;
        }

        public void Ship(int quantity)
        {
            if (quantity > Reserved) throw new InvalidOperationException("cannot ship more than was reserved");
            Reserved -= quantity;
            OnHand -= quantity;
        }

        public bool NeedsReorder() => Available() <= ReorderPoint;
    }
}
