using NUnit.Framework;

namespace Stockroom.Tests
{
    [TestFixture]
    public class SkuTests
    {
        [TestCase("abcd", "ABCD")]
        [TestCase(" wid-001 ", "WID-001")]
        [TestCase("123456789012", "123456789012")]
        public void NormalizesTheCode(string text, string expected)
        {
            Assert.That(Sku.Parse(text).Code, Is.EqualTo(expected));
        }

        [TestCase("abc")]
        [TestCase("1234567890123")]
        [TestCase("wid 001")]
        public void RejectsCodesItCannotBook(string text)
        {
            Assert.Throws<FormatException>(() => Sku.Parse(text));
        }

        [Test]
        public void TwoSkusWithOneCodeAreEqual()
        {
            Assert.That(Sku.Parse("wid-001"), Is.EqualTo(Sku.Parse("WID-001")));
        }
    }
}
