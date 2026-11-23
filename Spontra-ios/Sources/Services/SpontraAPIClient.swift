import Foundation

enum SpontraAPIError: LocalizedError {
    case invalidURL
    case httpStatus(Int)
    case decodingFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL: "无效的请求地址"
        case .httpStatus(let code): "服务器返回状态码 \(code)"
        case .decodingFailed(let detail): "数据解析失败：\(detail)"
        }
    }
}

actor SpontraAPIClient {
    static let shared = SpontraAPIClient()

    private let baseURL = "https://businessview.info"
    private let readSchema = "artifact-i18n-v2-layers"
    private let locale = "zh-CN"

    private let session: URLSession
    private let decoder: JSONDecoder

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: config)
        self.decoder = JSONDecoder()
    }

    func fetchHomeDigest() async throws -> HomeDigestResponse {
        try await request("/api/business/v1/home?lang=\(locale)")
    }

    func fetchResearchList() async throws -> PublicResearchListResponse {
        try await request("/api/business/v1/research")
    }

    func fetchResearchDetail(reportId: String, version: String?) async throws -> PublicResearchDetailResponse {
        let encodedId = reportId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? reportId
        var path = "/api/business/v1/research/\(encodedId)"
        if let version, !version.isEmpty {
            path += "?version=\(version)"
        }
        return try await request(path)
    }

    func fetchValuation(ticker: String) async throws -> ValuationAPIResponse {
        try await request(companyPath(ticker, resource: "/valuation"))
    }

    func fetchFilings(ticker: String) async throws -> FilingDigestsResponse {
        try await request(companyPath(ticker, resource: "/filings"))
    }

    func fetchFilingDetail(ticker: String, accession: String) async throws -> FilingDetailAPIResponse {
        let encodedAccession = accession.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? accession
        return try await request(companyPath(ticker, resource: "/filings/\(encodedAccession)"))
    }

    func fetchEvents(ticker: String) async throws -> EventsAPIResponse {
        try await request(companyPath(ticker, resource: "/events"))
    }

    private func companyPath(_ ticker: String, resource: String) -> String {
        let encoded = ticker.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ticker
        return "/api/business/v1/companies/\(encoded)\(resource)?schema=\(readSchema)&lang=\(locale)"
    }

    private func request<T: Decodable>(_ path: String) async throws -> T {
        guard let url = URL(string: baseURL + path) else {
            throw SpontraAPIError.invalidURL
        }
        var req = URLRequest(url: url)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("SpontraIOS/1.0", forHTTPHeaderField: "User-Agent")

        let (data, response) = try await session.data(for: req)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw SpontraAPIError.httpStatus(http.statusCode)
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw SpontraAPIError.decodingFailed(error.localizedDescription)
        }
    }
}
