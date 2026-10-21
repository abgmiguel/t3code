import Foundation
import PhononCoreML

struct Request: Decodable {
    let id: String
    let path: String
}

struct Response: Encodable {
    let type: String
    var id: String? = nil
    var text: String? = nil
    var error: String? = nil
}

func send(_ response: Response) throws {
    var data = try JSONEncoder().encode(response)
    data.append(10)
    try FileHandle.standardOutput.write(contentsOf: data)
}

do {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "T3Speech", code: 1) }
    var options = Transcriber.Options()
    options.functions = [15]
    options.decoderWorkers = 2
    options.fastDecoderThreads = 2
    let transcriber = try Transcriber(bundle: URL(fileURLWithPath: CommandLine.arguments[1]), options: options)
    try send(Response(type: "ready"))
    while let line = readLine() {
        let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
        try autoreleasepool {
            do {
                let result = try transcriber.transcribe(url: URL(fileURLWithPath: request.path))
                try send(Response(type: "transcript", id: request.id, text: result.text))
            } catch {
                try send(Response(type: "error", id: request.id, error: "Local speech could not read this recording."))
            }
        }
    }
} catch {
    try? send(Response(type: "error", error: "Local speech could not prepare the model."))
    exit(1)
}
