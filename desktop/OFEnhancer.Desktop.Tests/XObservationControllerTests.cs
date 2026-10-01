using System.Text.Json;
using OFEnhancer.Catalogue;
using OFEnhancer.Desktop;
using OFEnhancer.Protocol;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class XObservationControllerTests
{
    private const string Row = """
        {"statusId":"11","authorId":"1000000000000000001","authorHandle":"Owner_Handle","createdAt":"2026-09-27T12:00:00.000Z",
         "text":"benign teaser","inReplyToStatusId":null,"conversationId":"11","isRetweet":false,
         "media":[{"type":"video","mediaKey":"7_19","durationMs":15000,"posterUrl":null}],"urls":[],
         "metrics":{"views":100,"likes":10,"reposts":1,"replies":2,"quotes":0,"bookmarks":3},"source":"network"}
        """;

    private static JsonElement Payload(string rows, string owner = """{"accountId":"1000000000000000001","handle":"Owner_Handle"}""") =>
        JsonDocument.Parse($$"""{"owner":{{owner}},"observations":[{{rows}}]}""").RootElement.Clone();

    [TestMethod]
    public void RecordXObservationsIsAnAllowedAgentOperation()
    {
        AgentRequest request = AgentRequest.Parse(
            $$$"""{"protocolVersion":1,"requestId":"{{{Guid.NewGuid()}}}","operation":"recordXObservations","payload":{"owner":null}}""");
        Assert.AreEqual("recordXObservations", request.Operation);
    }

    [TestMethod]
    public void ControllerStoresOwnerRowsAndRejectsUnknownFieldsAndForeignAccounts()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"ofenhancer-x-controller-{Guid.NewGuid():N}");
        try
        {
            using CatalogueStore store = CatalogueStore.Open(Path.Combine(directory, "catalogue.db"));
            XObservationController controller = new(store, () => new DateTimeOffset(2026, 9, 28, 12, 0, 0, TimeSpan.Zero));

            Assert.AreEqual(new XObservationResult(1, 1, 0, 0), controller.Record(Payload(Row)));

            string extraField = Row.Replace("\"source\":\"network\"", "\"source\":\"network\",\"scraped\":true");
            Assert.AreEqual("invalid-x-observations",
                Assert.ThrowsException<GoogleCatalogueControllerException>(() => controller.Record(Payload(extraField))).Message);
            Assert.AreEqual("invalid-x-observations",
                Assert.ThrowsException<GoogleCatalogueControllerException>(() => controller.Record(JsonDocument.Parse("[]").RootElement)).Message);
            Assert.AreEqual("x-owner-mismatch",
                Assert.ThrowsException<GoogleCatalogueControllerException>(() => controller.Record(Payload(
                    Row.Replace("1000000000000000001", "2000000000000000002"),
                    """{"accountId":"2000000000000000002","handle":"Someone_Else"}"""))).Message);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }
}
