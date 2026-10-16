using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;
using Stockroom;

namespace Stockroom.Benchmarks
{
    public class ReserveBenchmark
    {
        private Warehouse _warehouse = new("bench");
        private Sku _sku = Sku.Parse("BEN-001");

        [GlobalSetup]
        public void Setup()
        {
            _warehouse = new Warehouse("bench");
            _warehouse.Stock(_sku, onHand: 1_000_000);
        }

        [Benchmark]
        public bool ReserveOne() => _warehouse.LevelOf(_sku).Reserve(1);

        public static void Main(string[] args) => BenchmarkRunner.Run<ReserveBenchmark>();
    }
}
