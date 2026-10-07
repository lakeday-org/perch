using NUnit.Framework;
using Stockroom.Reporting;

namespace Stockroom.Tests
{
    [TestFixture]
    public class WarehouseTests
    {
        private static readonly Sku Widget = Sku.Parse("WID-001");
        private static readonly Sku Gadget = Sku.Parse("GAD-001");
        private Warehouse _warehouse;

        [SetUp]
        public void OpenTheWarehouse()
        {
            _warehouse = new Warehouse("east");
            _warehouse.Stock(Widget, onHand: 5, reorderPoint: 2);
            _warehouse.Stock(Gadget, onHand: 1, reorderPoint: 2);
        }

        [Test]
        public void ReservesEveryLineOrNone()
        {
            var reserved = _warehouse.Reserve(new[] { (Widget, 3), (Gadget, 2) });
            Assert.That(reserved, Is.False);
            Assert.That(_warehouse.LevelOf(Widget).Available(), Is.EqualTo(5));
        }

        [Test]
        public void ReportsWhatIsAtItsReorderPoint()
        {
            var report = _warehouse.Reorders();
            Assert.That(report.Count, Is.EqualTo(1));
            Assert.That(report.Render(), Does.Contain("GAD-001 available 1 order 3"));
        }

        [Test]
        public void SuggestsEnoughToDoubleTheReorderPoint()
        {
            Assert.That(ReorderReport.SuggestedOrder(_warehouse.LevelOf(Gadget)), Is.EqualTo(3));
            Assert.That(ReorderReport.SuggestedOrder(_warehouse.LevelOf(Widget)), Is.EqualTo(0));
        }
    }
}
