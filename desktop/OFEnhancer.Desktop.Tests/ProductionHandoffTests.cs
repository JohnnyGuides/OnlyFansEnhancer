using System.Security.Cryptography;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;
using OFEnhancer.Protocol;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class ProductionHandoffTests
{
    private sealed class TempDirectory : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(),
            "OFEnhancerHandoffTests", Guid.NewGuid().ToString("N"));
        public TempDirectory() => Directory.CreateDirectory(Path);
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }

    [TestMethod]
    public async Task NativeDraftVerifiesBytesAndIsIdempotentAcrossRequests()
    {
        using TempDirectory temp = new();
        using var catalogue = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        var coordinator = new ProductionHandoffCoordinator(catalogue);
        var file = Path.Combine(temp.Path, "final.mp4");
        File.WriteAllBytes(file, [1, 2, 3, 4]);
        var request = Prepare(file);
        var first = await coordinator.HandleAsync(request, CancellationToken.None);
        Assert.IsTrue(first.Ok);
        Assert.AreEqual("awaiting-review", first.Status!.State);
        var retry = await coordinator.HandleAsync(request with { RequestId = Guid.NewGuid() },
            CancellationToken.None);
        Assert.IsTrue(retry.Ok);
        Assert.AreEqual(first.Status.HandoffId, retry.Status!.HandoffId);
        Assert.AreEqual(first.Status.State, retry.Status.State);
        CollectionAssert.AreEqual(first.Status.Files.ToArray(), retry.Status.Files.ToArray());
        Assert.AreEqual(1, catalogue.GetPendingProductionHandoffs().Count);
        File.WriteAllBytes(file, [4, 3, 2, 1]);
        var status = await coordinator.HandleAsync(new(1, Guid.NewGuid(),
            ProductionHandoffProtocol.StatusOperation, request.HandoffId), CancellationToken.None);
        Assert.IsTrue(status.Ok);
        Assert.AreEqual("changed-source", status.Status!.State);
        Assert.AreEqual("changed_source", catalogue.GetProductionHandoff(
            request.HandoffId.ToString("D"))!.State);
    }

    [TestMethod]
    public async Task NativeDraftRejectsPathInjectionAndIncorrectHash()
    {
        using TempDirectory temp = new();
        using var catalogue = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        var coordinator = new ProductionHandoffCoordinator(catalogue);
        var file = Path.Combine(temp.Path, "final.mp4");
        File.WriteAllBytes(file, [1, 2, 3]);
        var good = Prepare(file);
        var wrongHash = good with
        {
            Files = [good.Files![0] with { Sha256 = new string('0', 64) }]
        };
        Assert.AreEqual("changed-source", (await coordinator.HandleAsync(wrongHash,
            CancellationToken.None)).Error);
        var badPath = good with
        {
            Files = [good.Files![0] with { Path = file + ":other" }]
        };
        Assert.AreEqual("invalid-files", (await coordinator.HandleAsync(badPath,
            CancellationToken.None)).Error);
        Assert.IsNull(catalogue.GetProductionHandoff(good.HandoffId.ToString("D")));
    }

    [TestMethod]
    public async Task ReviewCannotBindAFileChangedAfterDraftPreparation()
    {
        using TempDirectory temp = new();
        using var catalogue = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        var coordinator = new ProductionHandoffCoordinator(catalogue);
        var file = Path.Combine(temp.Path, "final.mp4");
        File.WriteAllBytes(file, [1, 2, 3]);
        var request = Prepare(file);
        Assert.IsTrue((await coordinator.HandleAsync(request, CancellationToken.None)).Ok);
        File.WriteAllBytes(file, [3, 2, 1]);
        var error = await Assert.ThrowsExceptionAsync<ProductionHandoffException>(() =>
            coordinator.ReviewAsync(request.HandoffId, "bound", "any-item",
                CancellationToken.None));
        Assert.AreEqual("changed-source", error.Code);
        var saved = catalogue.GetProductionHandoff(request.HandoffId.ToString("D"))!;
        Assert.AreEqual("changed_source", saved.State);
        Assert.IsNull(saved.CatalogueItemId);
    }

    [TestMethod]
    public async Task SeparateCurrentUserPipeRoundTripsWithoutAgentOperations()
    {
        using TempDirectory temp = new();
        using var catalogue = CatalogueStore.Open(Path.Combine(temp.Path, "catalogue.db"));
        var coordinator = new ProductionHandoffCoordinator(catalogue);
        var file = Path.Combine(temp.Path, "final.mp4");
        File.WriteAllBytes(file, [1, 2, 3]);
        var pipeName = $"ofenhancer-production-test-{Guid.NewGuid():N}";
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var server = new ProductionHandoffPipeServer(pipeName);
        var request = Prepare(file);
        var serving = server.RunOnceAsync(coordinator.HandleAsync, stop.Token);
        var response = await new ProductionHandoffPipeClient(pipeName)
            .SendAsync(request, stop.Token);
        await serving;
        Assert.IsTrue(response.Ok);
        Assert.AreEqual(request.RequestId, response.RequestId);
        Assert.AreEqual("awaiting-review", response.Status!.State);
    }

    [TestMethod]
    public void WireProtocolRejectsUnknownOperationsAndFields()
    {
        var request = new ProductionHandoffRequest(1, Guid.NewGuid(),
            ProductionHandoffProtocol.StatusOperation, Guid.NewGuid());
        Assert.AreEqual(request, ProductionHandoffProtocol.ParseRequest(
            ProductionHandoffProtocol.Serialize(request)));
        Assert.ThrowsException<ProductionHandoffException>(() =>
            ProductionHandoffProtocol.ParseRequest(
                ProductionHandoffProtocol.Serialize(request).Replace("}", ",\"filePath\":\"C:\\\\injected.mp4\"}")));
        Assert.ThrowsException<ProductionHandoffException>(() =>
            ProductionHandoffProtocol.ParseRequest(ProductionHandoffProtocol.Serialize(
                request with { Operation = "browserExchange" })));
    }

    private static ProductionHandoffRequest Prepare(string file)
    {
        var bytes = File.ReadAllBytes(file);
        return new ProductionHandoffRequest(1, Guid.NewGuid(),
            ProductionHandoffProtocol.PrepareOperation, Guid.NewGuid(),
            Guid.NewGuid(), Guid.NewGuid(), "S5E8", 1,
            [new ProductionFinalFile(Guid.NewGuid(), "final-render", file,
                bytes.Length, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant())]);
    }
}
