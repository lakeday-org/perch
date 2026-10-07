using NUnit.Framework;

namespace Stockroom.Tests
{
    [TestFixture]
    public class StockLevelTests
    {
        private StockLevel _level;

        [SetUp]
        public void SetUp()
        {
            _level = new StockLevel(Sku.Parse("WID-001"), onHand: 10, reorderPoint: 3);
        }

        [Test]
        public void ReservingLeavesLessAvailable()
        {
            Assert.That(_level.Reserve(4), Is.True);
            Assert.That(_level.Available(), Is.EqualTo(6));
        }

        [Test]
        public void CannotReserveMoreThanIsAvailable()
        {
            _level.Reserve(8);
            Assert.That(_level.Reserve(3), Is.False);
            Assert.That(_level.Available(), Is.EqualTo(2));
        }

        [Test]
        public void ShippingTakesFromBothCounts()
        {
            _level.Reserve(4);
            _level.Ship(4);
            Assert.That(_level.OnHand, Is.EqualTo(6));
            Assert.That(_level.Reserved, Is.EqualTo(0));
        }

        [TestCase(7, false)]
        [TestCase(8, true)]
        public void NeedsReorderAtThePoint(int reserved, bool needsReorder)
        {
            _level.Reserve(reserved);
            Assert.That(_level.NeedsReorder(), Is.EqualTo(needsReorder));
        }

        [Test]
        public void StockOnHandCannotStartNegative()
        {
            Assert.Throws<ArgumentOutOfRangeException>(() => new StockLevel(Sku.Parse("WID-002"), -1, 0));
        }
    }
}
