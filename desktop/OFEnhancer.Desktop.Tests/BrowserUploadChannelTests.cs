using OFEnhancer.Protocol;
using System.Text.Json;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public class BrowserUploadChannelTests
{
    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [TestMethod]
    public async Task ExpiryCancelsPendingWorkAndDoesNotSwitchToAnotherSoleBrowser()
    {
        var clock = new Clock();
        using var channel = new BrowserUploadChannel(clock);
        string first = Guid.NewGuid().ToString(), second = Guid.NewGuid().ToString();
        channel.Exchange(Json(new { browserId = first }));
        var pending = channel.RequestAsync(Json(new { kind = "message" }));
        clock.Now += TimeSpan.FromSeconds(9);
        channel.Exchange(Json(new { browserId = second }));
        clock.Now += TimeSpan.FromSeconds(1);
        var status = Json(channel.Status());
        Assert.IsFalse(status.GetProperty("connected").GetBoolean());
        Assert.IsTrue(status.GetProperty("selectionRequired").GetBoolean());
        await Assert.ThrowsExceptionAsync<InvalidOperationException>(() => pending);
        await Assert.ThrowsExceptionAsync<InvalidOperationException>(() => channel.RequestAsync(Json(new { kind = "message" })));
        Assert.AreEqual(0, Json(channel.Exchange(Json(new { browserId = second }))).GetProperty("commands").GetArrayLength());
    }

    [TestMethod]
    public async Task RetiredConnectionCannotRestoreReadinessOrReceivePendingCommands()
    {
        using var channel = new BrowserUploadChannel();
        string browser = Guid.NewGuid().ToString(), old = Guid.NewGuid().ToString(), current = Guid.NewGuid().ToString();
        JsonElement Exchange(string connection) => JsonSerializer.SerializeToElement(new { browserId = browser, connectionId = connection });
        channel.Exchange(Exchange(old));
        var pending = channel.RequestAsync(Json(new { kind = "message" }));
        Assert.AreEqual(0, Json(channel.Exchange(Exchange(current))).GetProperty("commands").GetArrayLength());
        await Assert.ThrowsExceptionAsync<InvalidOperationException>(() => pending);
        Assert.ThrowsException<InvalidOperationException>(() => channel.Exchange(Exchange(old)));
        Assert.IsFalse(Json(channel.Status()).GetProperty("connected").GetBoolean());
    }
    [TestMethod]
    public async Task JsonAttachmentCannotEnterSelectedBrowserQueue()
    {
        using var channel = new BrowserUploadChannel();
        string browser = Guid.NewGuid().ToString();
        channel.Exchange(Json(new { browserId = browser }));
        channel.Select(browser);
        foreach (var command in new object[] {
            new { kind = "file", filePath = "C:\\private\\inert.mp4", sessionId = "pending123", token = "matching-token" },
            new { kind = "message", message = new { type = "OFENHANCER_APP_REQUEST", payload = new { kind = "file", filePath = "C:\\private\\inert.mp4" } } },
            new { kind = "port", message = new { type = "file-response", filePath = "C:\\private\\inert.mp4" } }
        })
        {
            await Assert.ThrowsExceptionAsync<InvalidOperationException>(() => channel.RequestAsync(Json(command)).WaitAsync(TimeSpan.FromMilliseconds(500)));
            Assert.AreEqual(0, Json(channel.Exchange(Json(new { browserId = browser }))).GetProperty("commands").GetArrayLength());
        }
    }

    private static JsonElement Json(object value)
    {
        var result = JsonSerializer.SerializeToElement(value);
        if (!result.TryGetProperty("browserId", out var id)) return result;
        var data = result.EnumerateObject().ToDictionary(property => property.Name, property => (object)property.Value);
        data["connectionId"] = id;
        return JsonSerializer.SerializeToElement(data);
    }

    [TestMethod]
    public async Task RequestsRequireLiveBrowserAndRepliesStayBound()
    {
        var channel = new BrowserUploadChannel();
        await Assert.ThrowsExceptionAsync<InvalidOperationException>(() => channel.RequestAsync(Json(new { kind = "message" })));
        string first = Guid.NewGuid().ToString(), second = Guid.NewGuid().ToString();
        channel.Exchange(Json(new { browserId = first }));
        var request = channel.RequestAsync(Json(new { kind = "storageGet", keys = new[] { "creatorToolkitV2" } }));
        var exchange = Json(channel.Exchange(Json(new { browserId = first })));
        string id = exchange.GetProperty("commands")[0].GetProperty("id").GetString()!;
        channel.Exchange(Json(new { browserId = second, replies = new[] { new { id, result = new { wrong = true } } } }));
        Assert.IsFalse(request.IsCompleted);
        channel.Exchange(Json(new { browserId = first, replies = new[] { new { id, result = new { accepted = true } } } }));
        Assert.IsTrue((await request).GetProperty("accepted").GetBoolean());
    }

    [TestMethod]
    public async Task MultipleBrowsersRequireSelectionAndCannotSwitchWhileRunning()
    {
        var channel = new BrowserUploadChannel();
        string first = Guid.NewGuid().ToString(), second = Guid.NewGuid().ToString();
        channel.Exchange(Json(new { browserId = first }));
        channel.Exchange(Json(new { browserId = second }));
        await Assert.ThrowsExceptionAsync<InvalidOperationException>(() => channel.RequestAsync(Json(new { kind = "message" })));
        channel.Select(first);
        var request = channel.RequestAsync(Json(new { kind = "message" }));
        Assert.ThrowsException<InvalidOperationException>(() => channel.Select(second));
        var sent = Json(channel.Exchange(Json(new { browserId = first })));
        string id = sent.GetProperty("commands")[0].GetProperty("id").GetString()!;
        channel.Exchange(Json(new { browserId = first, replies = new[] { new { id, result = new { } } } }));
        await request;
        channel.Select(second);
    }
}
