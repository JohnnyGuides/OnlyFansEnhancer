using System.Text.Json;
using OFEnhancer.Protocol;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public sealed class AgentProtocolTests
{
    private const string RequestId = "9b8dcfd6-30c7-4dc0-b6da-fb4aec1c5a9c";

    [TestMethod]
    public void CataloguePayloadAndResultRoundTripWithoutChangingStatusEnvelope()
    {
        AgentRequest request = AgentRequest.Parse($$$"""{"protocolVersion":1,"requestId":"{{{RequestId}}}","operation":"recordUploadResult","payload":{"row":2,"platform":"onlyfans"}}""");
        Assert.AreEqual(2, request.Payload!.Value.GetProperty("row").GetInt32());
        AgentResponse response = AgentProtocol.ParseResponse(AgentProtocol.Serialize(AgentResponse.SuccessResult(request, new { status = "recorded-local" })));
        Assert.AreEqual("recorded-local", response.Result!.Value.GetProperty("status").GetString());
        Assert.IsNull(response.Status);
    }

    [DataTestMethod]
    [DataRow("[]")]
    [DataRow("42")]
    public void RequestsRejectNonObjectPayloads(string payload)
    {
        Assert.ThrowsException<AgentProtocolException>(() => AgentRequest.Parse($$"""{"protocolVersion":1,"requestId":"{{RequestId}}","operation":"browserExchange","payload":{{payload}}}"""));
    }

    [TestMethod]
    public void Parse_accepts_one_status_request()
    {
        AgentRequest request = AgentRequest.Parse(
            $$"""{"protocolVersion":1,"requestId":"{{RequestId}}","operation":"getStatus"}"""
        );

        Assert.AreEqual(AgentProtocol.Version, request.ProtocolVersion);
        Assert.AreEqual(Guid.Parse(RequestId), request.RequestId);
        Assert.AreEqual("getStatus", request.Operation);
    }

    [TestMethod]
    public void Parse_rejects_unknown_protocol()
    {
        AgentProtocolException error = Assert.ThrowsException<AgentProtocolException>(() =>
            AgentRequest.Parse(
                $$"""{"protocolVersion":2,"requestId":"{{RequestId}}","operation":"getStatus"}"""
            )
        );

        Assert.AreEqual("unsupported-protocol", error.Code);
    }

    [TestMethod]
    public void Parse_rejects_unknown_operation()
    {
        AgentProtocolException error = Assert.ThrowsException<AgentProtocolException>(() =>
            AgentRequest.Parse(
                $$"""{"protocolVersion":1,"requestId":"{{RequestId}}","operation":"deleteEverything"}"""
            )
        );

        Assert.AreEqual("unsupported-operation", error.Code);
    }

    [DataTestMethod]
    [DataRow("")]
    [DataRow("not-json")]
    [DataRow("{}")]
    [DataRow("{\"protocolVersion\":1,\"requestId\":\"not-a-uuid\",\"operation\":\"getStatus\"}")]
    public void Parse_rejects_malformed_requests_without_echoing_them(string json)
    {
        AgentProtocolException error = Assert.ThrowsException<AgentProtocolException>(() =>
            AgentRequest.Parse(json)
        );

        Assert.AreEqual("invalid-request", error.Code);
        Assert.IsFalse(
            json.Length > 0 && error.Message.Contains(json, StringComparison.Ordinal)
        );
    }

    [TestMethod]
    public void Success_serializes_the_bounded_status_contract()
    {
        AgentRequest request = AgentRequest.Parse(
            $$"""{"protocolVersion":1,"requestId":"{{RequestId}}","operation":"getStatus"}"""
        );

        AgentResponse response = AgentResponse.Success(request, AgentStatus.Current);
        string json = AgentProtocol.Serialize(response);
        using JsonDocument document = JsonDocument.Parse(json);

        Assert.IsTrue(document.RootElement.GetProperty("ok").GetBoolean());
        Assert.AreEqual(RequestId, document.RootElement.GetProperty("requestId").GetString());
        JsonElement status = document.RootElement.GetProperty("status");
        Assert.AreEqual("0.20.53", status.GetProperty("productVersion").GetString());
        CollectionAssert.AreEqual(
            new[] { "desktop-shell", "local-file-attach", "native-bridge" },
            status.GetProperty("capabilities").EnumerateArray().Select(value => value.GetString()).ToArray()
        );
    }
}
